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

## Desarrollo sin Docker

Necesitas Node.js 22 y PostgreSQL 16.

```bash
# backend
cd backend && npm install
export DATABASE_URL=postgres://otc:otc@localhost:5432/otc
export JWT_SECRET=una-cadena-larga-de-al-menos-32-caracteres
npm run dev            # http://localhost:3000
npm test               # usa TEST_DATABASE_URL (por defecto .../otc_test); BORRA esa base

# frontend
cd frontend && npm install && npm run dev   # http://localhost:5173
```
