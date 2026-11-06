const META_PRICING_API_VERSION = 'v26.0';
const META_PRICING_API_BASE = `https://graph.facebook.com/${META_PRICING_API_VERSION}`;

export const PRICING_TIME_ZONE = 'America/Lima';

export interface PricingPeriod {
  start: string;
  end: string;
  startUnix: number;
  endUnix: number;
  timezone: typeof PRICING_TIME_ZONE;
}

export interface PricingBreakdownItem {
  pricingType: string;
  category: string;
  volume: number;
  cost: number | null;
}

export interface PricingAnalyticsResult {
  period: PricingPeriod;
  summary: {
    paidMessages: number;
    estimatedCost: number | null;
    freeCustomerService: number;
    freeEntryPoint: number;
  };
  breakdown: PricingBreakdownItem[];
  /** Meta did not return this during the production audit. Never infer it. */
  currency: string | null;
}

interface MetaPricingPoint {
  pricing_type?: unknown;
  pricing_category?: unknown;
  volume?: unknown;
  cost?: unknown;
  currency?: unknown;
}

interface MetaPricingResponse {
  pricing_analytics?: {
    data?: Array<{ data_points?: MetaPricingPoint[] }>;
  };
}

interface MetaErrorBody {
  error?: {
    code?: number;
    error_subcode?: number;
  };
}

export class PricingPeriodError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PricingPeriodError';
  }
}

export class MetaPricingAnalyticsError extends Error {
  readonly httpStatus: number;
  readonly code?: number;
  readonly errorSubcode?: number;
  readonly retryAfterSeconds?: number;

  constructor(args: {
    httpStatus: number;
    code?: number;
    errorSubcode?: number;
    retryAfterSeconds?: number;
  }) {
    super('Meta pricing analytics request failed');
    this.name = 'MetaPricingAnalyticsError';
    this.httpStatus = args.httpStatus;
    this.code = args.code;
    this.errorSubcode = args.errorSubcode;
    this.retryAfterSeconds = args.retryAfterSeconds;
  }
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsInTimeZone(date: Date, timezone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const values = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)])
  );
  return values as unknown as ZonedParts;
}

/** Convert a wall-clock time in an IANA timezone to the matching UTC instant. */
function zonedTimeToUtc(parts: ZonedParts, timezone: string): Date {
  const intendedUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  let candidate = intendedUtc;

  // A second pass handles zones whose offset changes near the requested time.
  for (let pass = 0; pass < 2; pass += 1) {
    const observed = partsInTimeZone(new Date(candidate), timezone);
    const observedAsUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second
    );
    candidate += intendedUtc - observedAsUtc;
  }

  return new Date(candidate);
}

function parseDateOnly(value: string, field: 'start' | 'end'): ZonedParts {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new PricingPeriodError(`${field} must use YYYY-MM-DD`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new PricingPeriodError(`${field} is not a valid date`);
  }
  return { year, month, day, hour: 0, minute: 0, second: 0 };
}

function asPeriod(start: Date, end: Date): PricingPeriod {
  if (end.getTime() <= start.getTime()) {
    throw new PricingPeriodError('end must be after start');
  }
  if (end.getTime() - start.getTime() > 366 * 24 * 60 * 60 * 1000) {
    throw new PricingPeriodError('date range cannot exceed 366 days');
  }
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    startUnix: Math.floor(start.getTime() / 1000),
    endUnix: Math.floor(end.getTime() / 1000),
    timezone: PRICING_TIME_ZONE,
  };
}

/** Current month in Lima by default; optional date-only bounds are end-exclusive. */
export function resolvePricingPeriod(
  args: {
    start?: string | null;
    end?: string | null;
    now?: Date;
  } = {}
): PricingPeriod {
  const { start, end, now = new Date() } = args;
  if (start || end) {
    if (!start || !end) {
      throw new PricingPeriodError('start and end must be provided together');
    }
    return asPeriod(
      zonedTimeToUtc(parseDateOnly(start, 'start'), PRICING_TIME_ZONE),
      zonedTimeToUtc(parseDateOnly(end, 'end'), PRICING_TIME_ZONE)
    );
  }

  const localNow = partsInTimeZone(now, PRICING_TIME_ZONE);
  const monthStart = zonedTimeToUtc(
    { ...localNow, day: 1, hour: 0, minute: 0, second: 0 },
    PRICING_TIME_ZONE
  );
  return asPeriod(monthStart, now);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

export function normalizePricingAnalytics(
  raw: MetaPricingResponse,
  period: PricingPeriod
): PricingAnalyticsResult {
  const points = (raw.pricing_analytics?.data ?? []).flatMap(
    (entry) => entry.data_points ?? []
  );
  const grouped = new Map<
    string,
    PricingBreakdownItem & { missingCost: boolean }
  >();
  const currencies = new Set<string>();

  for (const point of points) {
    const volume = finiteNumber(point.volume);
    if (volume === null || volume < 0) continue;
    const pricingType =
      typeof point.pricing_type === 'string' ? point.pricing_type : 'UNKNOWN';
    const category =
      typeof point.pricing_category === 'string'
        ? point.pricing_category
        : 'UNKNOWN';
    const cost = finiteNumber(point.cost);
    if (typeof point.currency === 'string' && point.currency.trim()) {
      currencies.add(point.currency.trim().toUpperCase());
    }

    const key = `${pricingType}\u0000${category}`;
    const current = grouped.get(key) ?? {
      pricingType,
      category,
      volume: 0,
      cost: 0,
      missingCost: false,
    };
    current.volume += volume;
    if (cost === null) current.missingCost = current.missingCost || volume > 0;
    else current.cost = rounded((current.cost ?? 0) + cost);
    grouped.set(key, current);
  }

  const breakdown = [...grouped.values()]
    .map(({ missingCost, ...item }) => ({
      ...item,
      cost: missingCost ? null : item.cost,
    }))
    .sort(
      (a, b) =>
        a.pricingType.localeCompare(b.pricingType) ||
        a.category.localeCompare(b.category)
    );

  const sumVolume = (pricingType: string) =>
    breakdown
      .filter((item) => item.pricingType === pricingType)
      .reduce((total, item) => total + item.volume, 0);
  const paid = breakdown.filter((item) => item.pricingType === 'REGULAR');
  const paidMessages = paid.reduce((total, item) => total + item.volume, 0);
  const estimatedCost =
    paidMessages === 0
      ? 0
      : paid.some((item) => item.cost === null)
        ? null
        : rounded(paid.reduce((total, item) => total + (item.cost ?? 0), 0));

  return {
    period,
    summary: {
      paidMessages,
      estimatedCost,
      freeCustomerService: sumVolume('FREE_CUSTOMER_SERVICE'),
      freeEntryPoint: sumVolume('FREE_ENTRY_POINT'),
    },
    breakdown,
    currency: currencies.size === 1 ? [...currencies][0] : null,
  };
}

function retryAfterSeconds(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? seconds : undefined;
}

export async function fetchPricingAnalytics(args: {
  wabaId: string;
  accessToken: string;
  period: PricingPeriod;
  fetchImpl?: typeof fetch;
}): Promise<PricingAnalyticsResult> {
  const { wabaId, accessToken, period, fetchImpl = fetch } = args;
  const fields =
    `pricing_analytics.start(${period.startUnix})` +
    `.end(${period.endUnix})` +
    '.granularity(DAILY)' +
    '.metric_types(VOLUME,COST)' +
    '.dimensions(PRICING_CATEGORY,PRICING_TYPE)';
  const url = new URL(`${META_PRICING_API_BASE}/${encodeURIComponent(wabaId)}`);
  url.searchParams.set('fields', fields);

  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  });

  let body: MetaPricingResponse & MetaErrorBody = {};
  try {
    body = (await response.json()) as MetaPricingResponse & MetaErrorBody;
  } catch {
    // Keep a controlled error below; never include raw bodies or headers.
  }

  if (!response.ok) {
    throw new MetaPricingAnalyticsError({
      httpStatus: response.status,
      code: body.error?.code,
      errorSubcode: body.error?.error_subcode,
      retryAfterSeconds: retryAfterSeconds(response.headers.get('retry-after')),
    });
  }

  return normalizePricingAnalytics(body, period);
}
