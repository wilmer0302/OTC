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

## Supuestos abiertos

- 1 USDT se trata como 1 dólar para aplicar la TRM.
- La fuente oficial automática de TRM no está elegida; en la demo se ingresa a mano y queda registrada.
- Los decimales de USDT por red (6 en Tron, 18 en BSC) se verifican contra cada contrato antes de integrar redes reales.
- No se verificó si Bancolombia ofrece una API de pagos para empresas; en la demo los pesos se registran con su referencia.
- Valores de ejemplo de la demo (umbral de 50.000.000 COP, límite de 200.000 USDT, vigencia de 120 s, saldos iniciales) son ficticios; cada cliente fija los suyos.

## Pendiente para versiones siguientes

- Segundo factor de autenticación (diseñado, no incluido en la demo).
- Adaptadores reales: TRM oficial, nodos o indexadores de Tron y BSC, Bancolombia.
- Integración con Trezor para firmar salidas.
- Política de qué hacer si el mercado USDT/COP se aleja de la TRM durante el día.
- KYC/AML y reportes regulatorios en Colombia.
- Método de costo para la ganancia realizada (hoy se muestra el margen frente a la TRM).
