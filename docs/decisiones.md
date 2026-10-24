# Decisiones técnicas y supuestos

Fecha de inicio: 2026-10-20. El diseño completo está en el documento de Fase 1.

## Decisiones tomadas

| # | Decisión | Por qué | Estado |
| --- | --- | --- | --- |
| 1 | Producto para vender; cada cliente tiene su propia instalación en su nube | El vendedor no opera ni interviene después de la venta; el cliente es dueño de datos y credenciales | Aprobada por Wilmer |
| 2 | Primera entrega: demo local en modo DEMO | Mostrar a compradores antes de cerrar contrato | Aprobada por Wilmer |
| 3 | Frontend, backend y base de datos separados; integraciones detrás de adaptadores | Principio 1; permite cambiar proveedor sin tocar el dominio | Propuesta |
| 4 | Backend como monolito modular en TypeScript; PostgreSQL | Menos piezas que operar; tipos compartidos; transacciones y decimales exactos | Propuesta, pendiente de aprobación |
| 5 | Precio = TRM − margen de compra / TRM + margen de venta, márgenes configurables (45 / 15 por defecto) | Regla de negocio dada por Wilmer | Aprobada |
| 6 | Sin TRM vigente no se cotiza | No inventar precios (principio 3) | Implementada |
| 7 | La app nunca firma ni guarda claves; las salidas se firman fuera y se registra el hash | Principio 7; la Trezor se integra más adelante | Implementada |
| 8 | Política de aprobación configurable: una persona, umbral o siempre dos | Cada comprador tiene un equipo distinto | Implementada |
| 9 | Libro contable de doble entrada; saldos solo desde asientos | Trazabilidad; nadie edita saldos | Implementada |
| 10 | Auditoría solo-agregar con hash encadenado; asientos contables inmutables (triggers) | Detectar alteraciones | Implementada |
| 11 | Operaciones de dinero idempotentes (`Idempotency-Key`) y referencias únicas | Un reintento no duplica pagos | Implementada |
| 12 | `APP_MODE=PRODUCTION` se niega a arrancar | No hay adaptadores reales; evita uso accidental | Implementada |
| 13 | Backend v1 en el esquema `otc` y bajo `/api/v1`; la demo anterior (`/api`) sigue funcionando hasta que el frontend migre | No romper lo existente (principio 2) | Implementada (fase 4) |
| 14 | Saldos de liquidez: libro de doble partida con cuadre verificado por la base al confirmar; saldo real nunca negativo; reservas con bloqueo de cuenta | Dos órdenes nunca usan el mismo saldo | Implementada (fase 4) |
| 15 | Reversos y ajustes sin endpoint propio: solo los hacen los flujos de órdenes y conciliación (ajustes con doble firma) | Nadie mueve saldos a mano | Implementada (fase 4) |
| 16 | Una solicitud que falla la validación se guarda como Rechazada con todos los motivos (no se descarta) | Trazabilidad de lo que pidió el cliente | Implementada (fase 4) |
| 17 | Aceptar una cotización serializa con un bloqueo global de límites; la reserva y la orden se crean en la misma transacción | Dos aceptaciones simultáneas no superan límites ni liquidez | Implementada (fase 4) |
| 18 | Una solicitud validada que vence sin cotización pasa a Cancelada (la especificación reserva Vencida para las cotizadas) | La especificación no permite Validada → Vencida | Implementada (fase 4), revisable |
| 19 | Proceso trabajador separado (`worker`) para vencimientos y seguimiento, misma imagen que el backend | Arquitectura aprobada en la fase 3 | Implementada (fase 4) |
| 20 | Confirmación reforzada: aprobaciones y cambios de configuración piden otra vez el código del segundo factor (cabecera `X-MFA-Code`, un solo uso) | Historia H13.2 | Implementada (fase 4) |
| 21 | Un pago reportado después del plazo no vence la orden: la manda a revisión con un pendiente abierto | El dinero pudo haber llegado; ante la duda, revisión | Implementada (fase 4) |
| 22 | Una orden solo se cancela sin dinero en movimiento; con pago reportado o confirmado se requiere devolución | Especificación: "una orden no se cancela después de que el cliente pagó" | Implementada (fase 4) |
| 23 | Con la política "una persona", quien creó la orden puede aprobar la entrega (la mesa opera con un trader central); con dos firmas, deben ser personas distintas | Dato del negocio: un trader central | Implementada (fase 4), revisable |
| 24 | La plataforma entrega la instrucción de envío (monto en unidades base, origen, destino de la lista blanca) y registra el hash; no firma | Principio 7 | Implementada (fase 4) |
| 25 | Un envío cancelado antes de salir devuelve la reserva a la orden; el reintento es una transferencia nueva enlazada, con aprobación y segundo factor | Especificación: una fallida nunca se reactiva | Implementada (fase 4) |
| 26 | Traslados entre cuentas propias: reservan en el origen al autorizarse; el destino sube solo al confirmarse. Las reservas pueden pertenecer a una transferencia sin orden (migración 010, no destructiva) | Historia H5.2 | Implementada (fase 4) |
| 27 | La consulta a la red o al banco se hace fuera de la transacción; el resultado se aplica solo si la transferencia sigue esperando ese resultado, si no queda como evidencia tardía | Regla de respuestas tardías | Implementada (fase 4) |
| 28 | Confirmada exige el umbral de confirmaciones y que coincidan destino, sentido y monto; exitosa a otra dirección o por otro monto va a revisión | Historia H8.2 | Implementada (fase 4) |
| 29 | Al resolver una revisión, Confirmada exige evidencia guardada que coincida; Fallida exige evidencia de falla o que nunca apareció | No inventar confirmaciones (principio 3) | Implementada (fase 4) |
| 30 | Toda llamada a una integración queda registrada con hora, duración y resultado; la evidencia se guarda cuando cambia | Historia H7.2 sin llenar la base con repeticiones | Implementada (fase 4) |
| 31 | Simulación sandbox (`/api/v1/sandbox/...`, permiso de simulación) solo existe en modo DEMO | Principio 4 | Implementada (fase 4) |
| 32 | Se retiró la función de la fase 4 que daba el cobro por confirmado sin evidencia; ahora el cobro avanza solo con la confirmación del banco o la red | Principio 3 | Implementada (fase 4) |
| 33 | Conciliación por cuenta y día de Bogotá: el extracto del banco o de la red (o uno cargado a mano para el exchange) se cruza por referencia, sentido y monto; lo que el libro confirmó y el extracto no muestra queda Sin contrapartida | Especificación, módulo 10 | Implementada (fase 4) |
| 34 | Ajustes contra la cuenta ADJUSTMENTS del activo, propuestos por Tesorería y aprobados por Administración (otra persona, segundo factor); el asiento original no se toca | Historias H10.2 y H11.2 | Implementada (fase 4) |
| 35 | Una partida en revisión se puede aclarar sin ajuste solo por Administración, con motivo y segundo factor | Diferencias de fecha que no son dinero | Implementada (fase 4), revisable |
| 36 | Consola nueva en `/consola/` (entrada propia de Vite, React + TypeScript) sobre `/api/v1`; la demo anterior en `/` no se toca | Implementar por módulos sin reemplazar todo de una vez | Implementada (fase 5) |
| 37 | La consola guarda la sesión solo en la cookie HttpOnly y el token anti-CSRF en memoria (se vuelve a pedir al recargar); nada en `localStorage` | Ningún secreto en el navegador | Implementada (fase 5) |
| 38 | Un código de segundo factor rechazado en una confirmación no cierra la sesión; solo la cierra una sesión vencida o inválida | Un error de digitación no debe sacar al operador | Implementada (fase 5) |
| 39 | Cada ventana de confirmación conserva una clave de idempotencia mientras está abierta: un doble clic o un reintento no repiten la operación | Escrituras críticas idempotentes | Implementada (fase 5) |
| 40 | El margen de la mesa en Inicio solo llega a quien gestiona precios o audita; el resto recibe `null` desde el servidor | La consola no filtra datos sensibles: el servidor no los envía | Implementada (fase 5) |
| 41 | Lecturas nuevas para la consola: `GET /system` (modo, público), `/dashboard`, `/quotes`, `/destinations`, `/adjustments` y filtros de `/transfers` (red y búsqueda) | Bandejas y métricas sin calcular nada en el navegador | Implementada (fase 5) |
| 42 | Los botones de aprobar se ocultan a quien propuso (ajustes, destinos, límites); el servidor rechaza igual la autoaprobación | Separación de funciones | Implementada (fase 5) |
| 43 | La consola no ofrece cambiar roles ni desactivar el propio usuario; el servidor solo exige que quede un administrador activo | Evitar errores; reforzarlo en el servidor queda por decidir | Implementada (fase 5), revisable |
| 44 | Solo se vinculan empresas: el servidor rechaza contrapartes que no sean persona jurídica con NIT. La base conserva los tipos de persona natural (no se migra), así que reabrirlo es un cambio de una regla | Pedido de Wilmer (2026-10-23): el comprador solo atiende clientes corporativos (B2B) | Implementada |
| 45 | Billeteras de origen por cliente (`otc.origin_addresses`): estados pendiente, aprobada, rechazada y revocada. Operación registra cada dirección y la aprueba otra persona de Cumplimiento, con segundo factor, nota y auditoría. Sin tope de direcciones por red | Un depósito de USDT solo se abona si sale de una billetera conocida del cliente (pedido de Wilmer, 2026-10-24) | Implementada sobre la red SIMULADA |
| 46 | Un cobro en Tron o BSC se abona solo si el origen que informa la red es una billetera APROBADA de ese cliente en esa misma red. Si es desconocida, pendiente, rechazada, revocada o de otro cliente, va a revisión, sin asiento contable ni liquidación | La regla vive en `decide()` del backend; el formulario no informa el origen | Implementada sobre la red SIMULADA |
| 47 | Toda transferencia en Tron o BSC exige que el contrato del token sea el USDT autorizado de esa red; si falta o no coincide, va a revisión. El símbolo del activo no basta | Un token falso con el mismo monto y destino pasaría sin este control | Implementada sobre la red SIMULADA; los contratos de la demo son ficticios |
| 48 | Máximo de redes distintas por cliente: 4 por defecto, en `platform/policy.ts` (variable `ORIGIN_MAX_NETWORKS`), validado en el servidor. Hoy solo hay dos redes soportadas (Tron y BSC), así que el tope no se alcanza; la prueba lo baja a 1 | Configuración central en un solo lugar | Implementada |
| 49 | Las direcciones se comparan por red: en BSC sin distinguir mayúsculas, en Tron exacta. Una dirección viva (pendiente o aprobada) no se repite en la misma red, ni para el mismo cliente ni para otro. La misma cadena en otra red es otra billetera | No suponer equivalencia entre redes | Implementada |
| 50 | Excepción de origen por depósito: Operación o Tesorería la solicitan con motivo y otra persona de Cumplimiento la autoriza con segundo factor. El origen se toma de la evidencia de la red, no del formulario. La excepción no abona nada: después un administrador resuelve la revisión y el servidor vuelve a exigir la evidencia. No sirve para tokens falsos ni montos distintos | Excepciones solo por un flujo explícito, con autorización independiente | Implementada sobre la red SIMULADA |

## Supuestos abiertos

- 1 USDT se trata como 1 dólar para aplicar la TRM.
- La fuente oficial automática de TRM no está elegida; en la demo se ingresa a mano y queda registrada.
- Los decimales de USDT por red (6 en Tron, 18 en BSC) se verifican contra cada contrato antes de integrar redes reales.
- No se verificó si Bancolombia ofrece una API de pagos para empresas; en la demo los pesos se registran con su referencia.
- La verificación del origen y del contrato del token (decisiones 45 a 50) corre hoy contra la red SIMULADA (`otc.sandbox_chain_txs`). En producción depende de lectores reales de Tron y BSC que todavía no existen y de los contratos oficiales de USDT, verificados en fuentes de Tether.
- Valores de ejemplo de la demo (umbral de 50.000.000 COP, límite de 200.000 USDT, vigencia de 120 s, saldos iniciales) son ficticios; cada cliente fija los suyos.

## Pendiente para versiones siguientes

- Segundo factor de autenticación: implementado en `/api/v1` (fase 4) y en la consola nueva (fase 5); la demo anterior aún no lo usa.
- Retirar la demo anterior (`/` y `/api`) cuando se apruebe; hoy convive con la consola nueva.
- Las dependencias de desarrollo `vite` y `esbuild` tienen avisos de seguridad que afectan solo al servidor de desarrollo; actualizarlas a la siguiente versión mayor requiere probar la compilación.
- Reforzar en el servidor que nadie cambie sus propios roles ni se desactive (decisión 43).
- Adaptadores reales: TRM oficial, nodos o indexadores de Tron y BSC, Bancolombia.
- Estado de salud de cada integración (degradada tras fallas repetidas, bloqueo de operaciones que dependen de ella).
- Costos de red (gas en BSC, energía en Tron) en el libro contable.
- Dirección de depósito de las cuentas de exchange, para verificar traslados hacia el exchange.
- Integración con Trezor para firmar salidas.
- Política de qué hacer si el mercado USDT/COP se aleja de la TRM durante el día.
- KYC/AML y reportes regulatorios en Colombia.
- Método de costo para la ganancia realizada (hoy se muestra el margen frente a la TRM).
