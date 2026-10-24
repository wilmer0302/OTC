# Mesa OTC · USDT / COP

Plataforma para mesas OTC que compran y venden USDT contra pesos colombianos en las redes Tron y BSC.
Se vende como producto: cada cliente instala su propia copia y configura sus márgenes, bancos, roles y
reglas de aprobación.

> **Estado actual: DEMO.** Todo corre en modo demostración: datos y clientes ficticios, bancos y redes
> **simulados**. Ningún fondo real se mueve y no hay credenciales reales. El modo producción se niega a
> arrancar hasta que existan adaptadores reales.

Diseño técnico completo: <https://claude.ai/artifact/6VoDLM9Cp1Va7YVH1RSLfV>

## Correr la demo en tu equipo

Requisito: [Docker Desktop](https://www.docker.com/products/docker-desktop/) instalado y abierto.

```bash
git clone https://github.com/wilmer0302/OTC.git
cd OTC
docker compose up --build
```

Abre <http://localhost:8080>. La primera vez tarda unos minutos mientras descarga y construye.

| Usuario | Contraseña | Roles |
| --- | --- | --- |
| `admin` | `demo1234` | Administrador y auditor |
| `trader` | `demo1234` | Operador y tesorero (el trader central) |
| `tesorero2` | `demo1234` | Tesorero (segunda aprobación) |
| `auditor` | `demo1234` | Solo lectura de auditoría |
| `cumplimiento` | `demo1234` | Cumplimiento (KYC y lista blanca de destinos), solo en `/api/v1` |
| `admin2` | `demo1234` | Segunda firma de administración, solo en `/api/v1` |

Para apagarla: `Ctrl + C`, y `docker compose down`. Para borrar los datos y empezar de cero:
`docker compose down -v`.

### Guion sugerido para mostrarla

1. Entra como `trader`. El panel avisa que no hay TRM: el sistema **no cotiza sin TRM**.
2. En **Configuración**, carga la TRM del día.
3. En **Cotizar**, elige un cliente, «El cliente compra USDT», 1.000 USDT. Verás TRM + 15.
4. Acepta: se crea la orden. Registra la referencia bancaria del cobro, aprueba, pega un hash de 64
   caracteres como entrega y verifica. La orden queda cerrada y el panel muestra el margen.
5. Cotiza una compra grande (por ejemplo 20.000 USDT, más de 50 millones de pesos): la orden pide una
   **segunda aprobación**; entra como `tesorero2` para darla.
6. Entra como `admin`: cambia márgenes o la política de aprobación, y en **Auditoría** pulsa
   «Verificar integridad».

## Consola de operación (`/consola/`)

Interfaz nueva de la fase 5, sobre `/api/v1`: <http://localhost:8080/consola/>. La demo anterior sigue en
<http://localhost:8080> sin cambios (el menú de la consola tiene el enlace «Abrir demo anterior»).

- **Ingreso**: usuario y contraseña de la tabla de arriba, y luego el **segundo factor**. La primera vez la
  consola muestra un código QR y la clave manual: regístralos en una aplicación de autenticación (Google
  Authenticator, Microsoft Authenticator, 1Password…) y escribe el código de 6 dígitos. Cada código sirve una
  sola vez; las aprobaciones y los cambios de configuración lo piden de nuevo.
- **Módulos**: Inicio y métricas, Solicitudes OTC, Cotizaciones, Órdenes y ejecución, Liquidez, Transferencias
  (USDT en Tron TRC20, USDT en BSC BEP20 y pesos por banco), Conciliaciones, Historial y auditoría, Clientes
  (KYC y destinos de pago) y Usuarios y configuración (usuarios, parámetros, TRM, reglas de precio, límites).
- En modo DEMO una franja fija dice **«DATOS SIMULADOS»**, y los paneles «Simulador» (solo para tesorería o
  administración) reemplazan lo que reportarían el banco o la red.
- La consola no calcula precios, saldos ni permisos: los pide al servidor. Ocultar un botón es solo
  comodidad; el servidor vuelve a verificar cada permiso.

Guion corto: entra como `trader`, carga la TRM en Inicio, crea una solicitud en **Solicitudes OTC**, cotiza y
acepta; en la orden registra el pago, simula la confirmación del banco, aprueba con tu código, prepara la
firma, pega un hash y simula la confirmación de la red: la orden queda **Completada**. Luego entra como
`cumplimiento` para aprobar el KYC de un cliente nuevo, o como `admin` para verificar la integridad de la
auditoría.

## Backend v1 (`/api/v1`)

El backend definitivo (fase 4) corre junto a la demo anterior, sin reemplazarla todavía: vive en el esquema
`otc` de PostgreSQL y bajo `/api/v1`. La consola nueva (`/consola/`) usa `/api/v1`; la demo anterior (`/`) sigue
usando `/api` hasta que se apruebe retirarla.

- **Sesión** por cookie HttpOnly, segundo factor obligatorio (TOTP) y token anti-CSRF. Aprobaciones y
  cambios de configuración piden otra vez el código (cabecera `X-MFA-Code`).
- **Escrituras críticas** con `Idempotency-Key`: repetir no duplica.
- **Flujo**: solicitud → cotización (TRM + margen + comisión, con plazo) → orden con liquidez reservada →
  pago registrado → cobro confirmado por el banco o la red → aprobación → envío firmado fuera (se registra el
  hash) → entrega confirmada → orden completada → conciliación diaria y cierre.
- **Trabajador** (`worker` en docker compose): vence cotizaciones, solicitudes y órdenes sin pago, sigue las
  transferencias contra la red y el banco y fija un ancla diaria de la auditoría.
- **Sandbox**: en modo DEMO, `POST /api/v1/sandbox/transfers/:id/simulate` y
  `POST /api/v1/sandbox/accounts/:id/movements` simulan lo que reportarían la red o el banco. No existen en
  producción.
- Datos ficticios: tres clientes, cuentas de liquidez de demo (Bancolombia, billeteras Tron y BSC, Binance) y
  límites de ejemplo.

Módulos en `backend/src/modules/`: identidad, contrapartes, precios, límites, liquidez, solicitudes y
cotizaciones (`trading`), órdenes, transferencias, confirmaciones, conciliación, auditoría y sandbox. Cada uno
tiene sus reglas puras (`domain.ts`), casos de uso (`service.ts`) y rutas (`routes.ts`). Las decisiones están
en [docs/decisiones.md](docs/decisiones.md).

## Estructura

```
backend/    API (Node.js + TypeScript + Fastify). Toda la lógica crítica vive aquí.
  migrations/   Esquema de PostgreSQL
  src/domain/   Reglas puras: precio sobre TRM, estados de la orden, política de aprobación
  src/services/ Casos de uso: cotizaciones, órdenes, libro contable, auditoría
  src/adapters/ Contratos con bancos y blockchain; hoy solo implementaciones simuladas
  test/         Pruebas unitarias y de punta a punta
frontend/   Consola web (React + Vite). Solo presenta y llama a la API.
docs/       Decisiones técnicas y supuestos
```

## Lector real de TRON (opcional, solo lectura)

Por omisión todas las redes son simuladas. Con estas variables, la API y el trabajador leen los depósitos USDT TRC-20 de la red TRON real. BSC y el banco siguen simulados, y la plataforma nunca firma ni envía fondos.

| Variable | Obligatoria | Uso |
| --- | --- | --- |
| `TRON_READER` | sí | `trongrid` activa el lector real; `sandbox` (por omisión) usa el simulador |
| `TRON_RPC_URL` | sí | URL del proveedor: `https://api.trongrid.io` (red principal) o `https://nile.trongrid.io` (pruebas). Debe usar https; solo un nodo local puede usar http |
| `TRON_USDT_CONTRACT` | sí | Contrato USDT autorizado. En la red principal es el publicado por Tether en https://tether.to/en/supported-protocols/ (`TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` al 2026-10-24); verifícalo antes de usarlo. En una red de pruebas va el contrato de prueba de esa red. Se rechaza el contrato ficticio del simulador |
| `TRON_API_KEY` | no | Llave de TronGrid, enviada en la cabecera `TRON-PRO-API-KEY`. Va al gestor de secretos, nunca al repositorio |
| `TRON_RPC_TIMEOUT_MS` | no | Tiempo máximo por consulta, de 1000 a 60000 (por omisión 8000) |

Un depósito se acredita solo si el recibo está en un bloque solidificado (irreversible), el evento `Transfer` es del contrato configurado, el monto y el destino coinciden y el origen es una billetera aprobada del cliente. Si algo falta o no cuadra, va a revisión. Si el nodo no responde, se reintenta en cada ciclo y, pasado el primer plazo, se abre un caso. Con el lector real, el simulador no escribe sobre TRON. La dirección TRON de la mesa (cuenta `WALLET_TRON_DEMO` de la demo) debe ser la billetera real que recibe.

## Desarrollo sin Docker

Necesitas Node.js 22 y PostgreSQL 16.

```bash
# backend
cd backend && npm install
export DATABASE_URL=postgres://otc:otc@localhost:5432/otc
export JWT_SECRET=una-cadena-larga-de-al-menos-32-caracteres
export MFA_ENCRYPTION_KEY=$(openssl rand -hex 32)   # cifra los secretos del segundo factor
export COOKIE_SECURE=false                          # solo en http://localhost
npm run dev            # http://localhost:3000
npx tsx src/worker.ts  # trabajador, en otra terminal
npm test               # usa TEST_DATABASE_URL (por defecto .../otc_test); BORRA esa base
npx vitest run test/v1/tron.test.ts   # solo el lector de TRON (nodo falso, sin conexión a la red)
# prueba REAL de solo lectura contra un nodo TRON; fuera de `npm test`, deja el informe en test-real/out/
TRON_RPC_URL=https://nile.trongrid.io npm run test:tron-real   # ver variables en test-real/tron.real.test.ts

# frontend
cd frontend && npm install && npm run dev   # http://localhost:5173
```
