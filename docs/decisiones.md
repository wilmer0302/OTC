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

## Supuestos abiertos

- 1 USDT se trata como 1 dólar para aplicar la TRM.
- La fuente oficial automática de TRM no está elegida; en la demo se ingresa a mano y queda registrada.
- Los decimales de USDT por red (6 en Tron, 18 en BSC) se verifican contra cada contrato antes de integrar redes reales.
- No se verificó si Bancolombia ofrece una API de pagos para empresas; en la demo los pesos se registran con su referencia.
- Valores de ejemplo de la demo (umbral de 50.000.000 COP, límite de 200.000 USDT, vigencia de 120 s, saldos iniciales) son ficticios; cada cliente fija los suyos.

## Pendiente para versiones siguientes

- Segundo factor de autenticación: implementado en `/api/v1` (fase 4); la demo anterior aún no lo usa.
- Adaptadores reales: TRM oficial, nodos o indexadores de Tron y BSC, Bancolombia.
- Estado de salud de cada integración (degradada tras fallas repetidas, bloqueo de operaciones que dependen de ella).
- Costos de red (gas en BSC, energía en Tron) en el libro contable.
- Dirección de depósito de las cuentas de exchange, para verificar traslados hacia el exchange.
- Integración con Trezor para firmar salidas.
- Política de qué hacer si el mercado USDT/COP se aleja de la TRM durante el día.
- KYC/AML y reportes regulatorios en Colombia.
- Método de costo para la ganancia realizada (hoy se muestra el margen frente a la TRM).
