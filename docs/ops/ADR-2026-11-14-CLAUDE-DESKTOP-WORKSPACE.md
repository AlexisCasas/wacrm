# ADR-2026-11-14 — Espacio de desarrollo separado para Claude Desktop en WACRM

- **Fecha de decisión:** 2026-11-14 (America/Lima)
- **Estado de la decisión:** Aprobada
- **Estado de implementación:** Pendiente de completar y validar
- **Proyecto:** WACRM
- **Repositorio central:** `AlexisCasas/wacrm`
- **Tipo:** Decisión operativa de desarrollo y despliegue
- **Alcance de este documento:** Documentación; no constituye autorización de despliegue ni constancia de ejecución de los pasos pendientes.

## Contexto

WACRM está funcionando en el VPS. Ya existe una sesión de Claude Code que utiliza el usuario Linux `root`. Se necesita conectar una segunda sesión de Claude Desktop para desarrollar, modificar código, crear commits y proponer cambios sin que ambas sesiones editen directamente el árbol de trabajo asociado a producción.

En la revisión del 14/11/2026 se verificó:

| Comprobación | Evidencia / estado |
| --- | --- |
| Repositorio existente en VPS | `/opt/apps/wacrm`; legible por `deploy` |
| Claude Code en VPS | Binario `/usr/bin/claude` |
| Usuario Linux reutilizable | `deploy`; sin `sudo` |
| Acceso SSH desde Mac como `deploy` | Prueba por llave pública satisfactoria: `whoami=deploy`, hostname y directorio WACRM reconocidos |
| Escritura directa de `deploy` en `/opt/apps/wacrm` | No disponible, conforme a la auditoría |
| Grupo `docker` de `deploy` | **Sí**; riesgo de privilegios equivalentes a `root` |
| Carpeta `/home/deploy/wacrm-dev` | **No consta creada todavía** |
| Autenticación GitHub para push con `deploy` | **No verificada** |
| Segunda cuenta de Claude Code autenticada como `deploy` | **No verificada** |

No se adjuntan llaves, contraseñas, tokens, direcciones de correo ni información sensible al repositorio.

## Decisión aprobada

**Trabajar con un espacio de código independiente bajo `/home/deploy/wacrm-dev`, conectado al mismo repositorio GitHub, y dejar `/opt/apps/wacrm` sin edición directa desde la nueva sesión de Claude Desktop.**

Esta segunda carpeta será una copia de **código Git**, no una segunda instancia de la aplicación. **No** se replicarán datos productivos, bases de datos, archivos de usuarios, secretos ni contenedores. Tampoco se levantarán servicios duplicados por defecto.

| Componente | Ruta o recurso | Uso |
| --- | --- | --- |
| Código asociado a producción | `/opt/apps/wacrm` | Mantener protegido; solo operativa de despliegue autorizada |
| Código editable de Claude Desktop | `/home/deploy/wacrm-dev` | Ramas, cambios, pruebas, commits |
| Fuente central y colaboración | `https://github.com/AlexisCasas/wacrm` | Pull Requests, revisión, trazabilidad |
| Base y servicios productivos | Los actuales del VPS | Sin cambios por esta decisión |

El flujo aprobado es: **sincronizar rama base → desarrollar en rama propia → validar → push a GitHub → Pull Request → revisión/aprobación → despliegue controlado → verificación posterior**.

**No se acepta** que un commit, un push o el mero acceso SSH activen por sí solos un despliegue. El procedimiento efectivo de despliegue, sus controles y cualquier automatización existente deberán auditarse antes de habilitar nuevas acciones.

## Razones y alternativas

1. **Edición directa del árbol de producción:** descartada como forma ordinaria de desarrollo; presenta riesgo de interferencia entre sesiones y de cambios fuera de la trazabilidad de PR.
2. **Copia de código en el mismo VPS:** aceptada como paso inicial por su facilidad de operación. Reduce modificaciones accidentales sobre el directorio de producción, aunque **no es una barrera de seguridad**.
3. **Usuario Linux nuevo / servidor aislado:** no es necesario para iniciar el flujo. Puede reconsiderarse si se requieren garantías más fuertes de aislamiento.

## Controles obligatorios

- **Permisos:** `deploy` deberá poder escribir solo en su espacio de desarrollo y otros recursos expresamente aprobados. No cambiar el propietario de `/opt/apps/wacrm` ni otorgar permisos amplios sobre ese directorio para resolver errores de Git.
- **Riesgo Docker:** `deploy` pertenece actualmente a `docker`, lo que puede otorgarle acceso equivalente a `root`. Antes de considerar el entorno aislado o permitir operaciones de producción, auditar dependencias y decidir un esquema de privilegios mínimos. No retirar ese grupo sin evaluar despliegues existentes.
- **GitHub:** configurar identidad y autenticación de `deploy` con credenciales propias y alcance limitado. Verificar permiso de push sin exponer tokens ni llaves privadas.
- **Ramas:** trabajar en ramas por cambio. No trabajar directamente sobre `main`; no hacer push forzado ni merge automático sin autorización.
- **Secretos y datos:** no copiar `.env`, credenciales, respaldos de bases de datos ni almacenamiento de producción al repositorio editable; usar configuraciones de prueba seguras cuando correspondan.
- **Colaboración:** si dos Claude trabajan en paralelo, usar directorios/ramas de trabajo distintos y revisar conflictos antes de integrar.
- **QA/despliegue:** tests y revisión por PR; respaldo, preflight, ventana de despliegue y verificaciones posteriores según el procedimiento operativo vigente.

## Plan de implementación (pendiente)

1. Verificar estado y remotos del repositorio antes de copiarlo; identificar la fuente base autorizada. Preferir clonar el repositorio central GitHub en `/home/deploy/wacrm-dev` como `deploy`. Si se necesita partir de cambios locales no publicados, auditarlos por separado antes de migrarlos.
2. Verificar que `deploy` sea propietario del directorio de desarrollo y pueda editar archivos y crear commits.
3. Configurar la autenticación de GitHub de `deploy` y probar conectividad/alcance; no realizar pushes de prueba a `main`.
4. Configurar Claude Desktop con la conexión SSH existente y seleccionar `/home/deploy/wacrm-dev` como carpeta del proyecto. Mantener trabajo directo sobre producción fuera de alcance.
5. Verificar en modo lectura el repositorio, rama activa, remotos y permisos. Ejecutar una prueba de edición/commit solo en rama de desarrollo.
6. Auditar pertenencia al grupo Docker y definir restricciones; verificar que no exista despliegue automático imprevisto al hacer push.
7. Cerrar la implementación con evidencia: lectura/escritura en directorio de desarrollo, PR de prueba o real, y producción sin cambios.

## Criterios de aceptación

- [ ] `/home/deploy/wacrm-dev` creado y perteneciente a `deploy`.
- [ ] `git remote -v` señala el repositorio central correcto.
- [ ] Claude Desktop abre ese directorio y puede trabajar en una rama distinta de `main`.
- [ ] Autenticación de GitHub y push a rama de desarrollo probados.
- [ ] El usuario `deploy` no requiere modificar `/opt/apps/wacrm` para desarrollar.
- [ ] Riesgo de `docker` evaluado y decisión de permisos documentada.
- [ ] Controles de despliegue y ausencia de efectos automáticos verificados.
- [ ] Producción sin cambios derivados de la preparación.

## Consecuencias

**Beneficios:** colaboración entre sesiones, trazabilidad en GitHub y menor riesgo de modificar el árbol asociado a producción durante el desarrollo.

**Limitaciones:** ambos directorios siguen en el mismo VPS; el grupo `docker` puede permitir intervenir en producción; clonar código no equivale a aislar los datos ni el sistema operativo. Se requiere mantener sincronización de Git y validar el pipeline real antes de desplegar.

## Historial

- **2026-11-14:** decisión aprobada en conversación de trabajo. Registro documental creado en GitHub. La aprobación se refiere a la arquitectura de trabajo, **no** a una ejecución de cambios productivos.
