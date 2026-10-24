# Pendientes antes de producción: control de origen de depósitos

Estado al 2026-10-24. Vienen de la revisión técnica de los PR #3, #4 y #5. I1 e I2 (en la red) están resueltos; el resto no. Los que dependen de lectores reales de Tron o BSC no se pueden dar por resueltos hasta que esos lectores existan y se prueben en testnet y en modo sombra.

Hoy el modo PRODUCTION se niega a arrancar (`backend/src/config.ts`), así que estos puntos no afectan la demo.

Todas las pruebas actuales corren contra la red SIMULADA (`otc.sandbox_chain_txs`). No demuestran seguridad en Tron ni en BSC reales.

## I1. Carrera entre revocar una billetera y confirmar un depósito — resuelto para los orígenes

**Estado (2026-10-24).** `checkTransfer` y `resolveTransferReview` vuelven a leer los orígenes autorizados dentro de la transacción, después de `lockTransfer`, con `FOR SHARE` sobre las billeteras y las excepciones. Pruebas en `test/v1/tron.test.ts` (revocación confirmada durante la consulta, revocación en curso al decidir, tres revisiones simultáneas con un solo asiento). Los destinos no se bloquean: en una entrega el destino queda fijado en la transferencia antes de enviarla.

**Problema.** `checkTransfer` calcula los orígenes autorizados fuera de la transacción (`confirmations/service.ts`, `loadTarget(db, …)`) y decide dentro de ella con ese cálculo. Supongamos que Cumplimiento revoca la billetera entre los dos momentos. El depósito se abona igual desde una billetera ya revocada. Lo mismo ocurre con los destinos aprobados.

**Criterios de aceptación**
- Los orígenes y destinos autorizados se leen dentro de la misma transacción que aplica la decisión, después de `lockTransfer`.
- Esas filas se bloquean para que una revocación concurrente espere o gane.
- Una revocación ya confirmada antes de aplicar la decisión siempre manda el depósito a revisión.

**Pruebas necesarias**
- Prueba determinista con un lector de prueba cuyo `getTransaction` revoque la billetera durante la consulta: el resultado debe ser EN_REVISION y sin asiento.
- La misma prueba con un destino de entrega revocado.

## I2. Monto y destino opcionales en `decide()` — resuelto en la red (decisión 51)

**Problema.** `confirmations/domain.ts` solo compara el monto y el destino si el lector los informa. El contrato del token y el origen sí son obligatorios. Un lector real que omita el monto dejaría pasar un depósito por otro importe.

**Criterios de aceptación**
- En Tron y BSC, que falten el monto, el destino, el contrato o el origen manda a revisión.
- En el banco se mantiene el comportamiento actual, salvo que se decida lo contrario.

**Pruebas necesarias**
- Casos puros de `decide()` sin `amount` y sin `to` en la red: REVIEW.
- Las pruebas existentes de confirmaciones siguen pasando.

## I3. Separación de funciones que depende del administrador

**Problema.** El administrador puede cambiarse sus propios roles (`identity/service.ts`, `setRoles`; decisión 43) o crear un segundo usuario que cuente como “otra persona”. Además, nada impide combinar CUMPLIMIENTO con ADMIN, así que una sola persona podría autorizar una excepción y resolver la revisión. Todo queda auditado, pero no se impide.

**Criterios de aceptación**
- El servidor rechaza que un usuario cambie sus propios roles o se desactive.
- Se define una lista de combinaciones de roles incompatibles, por ejemplo CUMPLIMIENTO con ADMIN, y el servidor la valida.
- Quien resuelve la revisión de un depósito con excepción es distinto de quien la pidió y de quien la autorizó.
- Crear usuarios exige una segunda aprobación o una alerta de auditoría. Esto es una decisión de Innova.

**Pruebas necesarias**
- Cambiar los roles propios: FORBIDDEN.
- Asignar una combinación incompatible: INVALID.
- Resolver una revisión siendo quien autorizó la excepción: FORBIDDEN.

## I4. Datos de demo cargados en cualquier modo

**Problema.** `server.ts` llama a `seedDemo` y a `seedDemoV1` sin mirar el modo. Eso incluye cuatro billeteras de origen ficticias ya APROBADAS (`seedV1.ts`, `DEMO_ORIGINS`).

**Criterios de aceptación**
- Los datos de demo solo se cargan con `APP_MODE=DEMO`.
- En PRODUCTION, arrancar sobre una base con datos de demo falla con un mensaje claro.

**Pruebas necesarias**
- Arrancar en PRODUCTION con integraciones de prueba no inserta ninguna fila de demo.
- Arrancar sobre una base con filas de demo se niega.

## I5. Contratos USDT de producción — TRON: lector real implementado, sin validar contra la red real

**Problema.** Solo existen los contratos de la red simulada, que son ficticios a propósito (`integrations/sandbox.ts`, `SANDBOX_USDT_CONTRACT`). El servidor y el trabajador usan siempre las integraciones sandbox.

**Criterios de aceptación**
- Lectores reales para Tron y BSC, cada uno con el contrato USDT oficial de su red.
- Cada contrato se verifica contra fuentes oficiales de Tether y del explorador de la red. Las direcciones no se inventan ni se copian de memoria.
- Los contratos quedan en una configuración central por red, con el decimal de cada contrato verificado (6 en Tron y 18 en BSC, según el supuesto actual).
- Al arrancar en PRODUCTION se rechaza cualquier contrato de la red simulada y cualquier integración sandbox.
- Nunca se usan contratos ficticios en una configuración de producción.

**Pruebas necesarias**
- Prueba de arranque: PRODUCTION con `SANDBOX_USDT_CONTRACT` falla.
- En testnet, leer una transferencia USDT conocida: el contrato, el monto en unidades base, el origen y el destino coinciden con el explorador.
- En modo sombra, comparar durante un periodo las decisiones del lector real con la verificación manual, sin abonar nada.

## I8. Clientes que envían desde un exchange, y qué significa “origen” en la red

**Problema.**
- Un cliente que retira desde Binance u otro exchange envía desde una dirección compartida por muchos usuarios. Aprobarla no identifica al cliente.
- El índice único (`014_origenes.sql`) solo deja registrarla a un cliente.
- En TRC20 y BEP20, el `from` del evento Transfer puede ser distinto de quien firmó la transacción. También puede haber varios eventos en una misma transacción.

**Decisión pendiente de Wilmer e Innova.** Hay dos caminos: aceptar solo billeteras propias del cliente, o crear otro mecanismo para quien envía desde un exchange, como una dirección de depósito por cliente o un memo verificable.

**Criterios de aceptación**
- La política está escrita en `docs/decisiones.md`.
- El lector real toma como origen el `from` del evento Transfer del contrato USDT autorizado.
- Una transacción con varios eventos del contrato, o con eventos de otros contratos que afecten a la mesa, va a revisión.

**Pruebas necesarias**
- Con transacciones reales de testnet: una transferencia directa, una hecha con `transferFrom` y una con varios eventos. Cada una con el origen y la decisión esperados.

## I9. Depósitos desde un origen no aprobado sin salida

**Problema.** Si la red muestra exitoso un depósito que vino de un origen no aprobado, no se puede dar por fallido (`confirmations/service.ts`, `resolveTransferReview`). Sin excepción, queda en revisión para siempre y no existe un flujo de devolución.

**Criterios de aceptación**
- Hay un flujo de devolución al origen informado por la red, con su propia transferencia de salida.
- La devolución exige aprobación de Cumplimiento y de Tesorería, se firma fuera de la plataforma, igual que las entregas, y queda auditada.
- El depósito original queda cerrado con un estado propio, sin asiento de cobro.
- Los costos de red de la devolución se registran.

**Pruebas necesarias**
- Un depósito rechazado por origen se devuelve. El libro cuadra, no hay cobro de la orden y queda la auditoría completa.
- No se puede devolver a una dirección distinta de la que informó la red.

## Lo que ya está verificado (solo contra la red simulada)

- La excepción la autoriza otra persona y no cambia el importe, el destino, el contrato ni las confirmaciones exigidas.
- Un depósito en revisión no genera asiento.
- El segundo factor se exige al aprobar, rechazar o revocar una billetera y al decidir una excepción.
- Con solicitudes simultáneas se respetan el tope de redes y la unicidad de la dirección.

Las pruebas están en `backend/test/v1/origins.test.ts`.
