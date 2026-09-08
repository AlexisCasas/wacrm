'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { toast } from 'sonner';
import type { Contact } from '@/types';
import { useCan } from '@/hooks/use-can';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { ArrowLeft, ChevronLeft, ChevronRight, Loader2, ShieldOff } from 'lucide-react';

const PAGE_SIZE = 25;

interface BlockedContactRow extends Contact {
  blocked_by_name: string | null;
}

/**
 * Contacts → Blocked — P0 admin screen for internal WACRM contact
 * blocking (migration 044). Lists blocked contacts for this account
 * (RLS already scopes `contacts` to account members, so a viewer can
 * read this list; only agent+ can unblock — same capability as
 * blocking itself). Reuses the same 25-row pagination + name/phone
 * search pattern as the main Contacts list.
 */
export default function BlockedContactsPage() {
  const t = useTranslations('Contacts.blocked');
  const supabase = createClient();
  const canUnblock = useCan('send-messages');

  const [contacts, setContacts] = useState<BlockedContactRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [unblockTarget, setUnblockTarget] = useState<BlockedContactRow | null>(null);
  const [unblocking, setUnblocking] = useState(false);

  const fetchBlocked = useCallback(async () => {
    setLoading(true);
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    const term = search.trim();

    let query = supabase
      .from('contacts')
      .select('*', { count: 'exact' })
      .eq('blocked', true)
      .order('blocked_at', { ascending: false })
      .range(from, to);

    if (term) {
      const like = `%${term}%`;
      query = query.or(`name.ilike.${like},phone.ilike.${like}`);
    }

    const { data, count, error } = await query;
    if (error) {
      toast.error(t('toastFailedLoad'));
      setLoading(false);
      return;
    }

    const rows = (data ?? []) as Contact[];
    setTotalCount(count ?? 0);

    // Resolve blocked_by_user_id -> profile full_name for this page's
    // rows. profiles_select already lets any account member read a
    // teammate's profile.
    const userIds = Array.from(
      new Set(
        rows
          .map((c) => c.blocked_by_user_id)
          .filter((id): id is string => !!id),
      ),
    );
    let namesByUserId: Record<string, string> = {};
    if (userIds.length > 0) {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, full_name')
        .in('user_id', userIds);
      namesByUserId = Object.fromEntries(
        (profiles ?? []).map((p) => [p.user_id as string, p.full_name as string]),
      );
    }

    setContacts(
      rows.map((c) => ({
        ...c,
        blocked_by_name: c.blocked_by_user_id
          ? (namesByUserId[c.blocked_by_user_id] ?? null)
          : null,
      })),
    );
    setLoading(false);
  }, [supabase, page, search, t]);

  useEffect(() => {
    fetchBlocked();
  }, [fetchBlocked]);

  async function handleUnblock() {
    if (!unblockTarget) return;
    setUnblocking(true);
    try {
      const res = await fetch(`/api/contacts/${unblockTarget.id}/unblock`, {
        method: 'POST',
      });
      if (!res.ok) {
        toast.error(t('toastFailedUnblock'));
        return;
      }
      toast.success(t('toastUnblocked'));
      setUnblockTarget(null);
      fetchBlocked();
    } catch {
      toast.error(t('toastFailedUnblock'));
    } finally {
      setUnblocking(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Link
          href="/contacts"
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={t('backToContacts')}
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="text-lg font-semibold text-foreground">{t('title')}</h1>
      </div>

      <Input
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setPage(0);
        }}
        placeholder={t('searchPlaceholder')}
        className="max-w-sm"
      />

      <div className="overflow-x-auto rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('columnName')}</TableHead>
              <TableHead>{t('columnPhone')}</TableHead>
              <TableHead>{t('columnBlockedAt')}</TableHead>
              <TableHead>{t('columnBlockedBy')}</TableHead>
              <TableHead>{t('columnInboundCount')}</TableHead>
              <TableHead>{t('columnLastInbound')}</TableHead>
              <TableHead className="text-right">{t('columnAction')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
                </TableCell>
              </TableRow>
            ) : contacts.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="py-8 text-center text-sm text-muted-foreground"
                >
                  {t('empty')}
                </TableCell>
              </TableRow>
            ) : (
              contacts.map((c) => (
                <TableRow key={c.id}>
                  <TableCell>{c.name || t('unnamed')}</TableCell>
                  <TableCell>{c.phone}</TableCell>
                  <TableCell>
                    {c.blocked_at ? new Date(c.blocked_at).toLocaleString() : '—'}
                  </TableCell>
                  <TableCell>{c.blocked_by_name ?? '—'}</TableCell>
                  <TableCell>{c.blocked_inbound_count ?? 0}</TableCell>
                  <TableCell>
                    {c.last_blocked_inbound_at
                      ? new Date(c.last_blocked_inbound_at).toLocaleString()
                      : '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    {canUnblock && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setUnblockTarget(c)}
                      >
                        <ShieldOff className="mr-1 h-3.5 w-3.5" />
                        {t('unblockAction')}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>{t('pageCount', { page: page + 1, total: totalPages })}</span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={page + 1 >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      <Dialog
        open={!!unblockTarget}
        onOpenChange={(next) => !unblocking && !next && setUnblockTarget(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('unblockConfirmTitle')}</DialogTitle>
            <DialogDescription>{t('unblockConfirmDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setUnblockTarget(null)}
              disabled={unblocking}
            >
              {t('unblockCancel')}
            </Button>
            <Button onClick={handleUnblock} disabled={unblocking}>
              {unblocking ? t('unblocking') : t('unblockConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
