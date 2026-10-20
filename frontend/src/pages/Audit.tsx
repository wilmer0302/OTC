import { api } from '../api';
import { dateTime } from '../format';
import { useAction, useLoad } from '../hooks';
import { useState } from 'react';

export default function Audit() {
  const list = useLoad<any[]>('/audit?limit=200');
  const [check, setCheck] = useState<{ ok: boolean; checked: number; brokenAt?: string } | null>(null);
  const { busy, error, run } = useAction();

  return (
    <section>
      <h2>Auditoría</h2>
      <p className="muted">
        Registro solo-agregar: nadie puede editarlo ni borrarlo, y cada entrada está encadenada a la anterior por hash.
      </p>
      <button disabled={busy} onClick={() => run(async () => setCheck(await api('GET', '/audit/verify')))}>
        Verificar integridad
      </button>
      {check && (
        <p className={check.ok ? 'ok' : 'error'}>
          {check.ok
            ? `Cadena íntegra: ${check.checked} registros verificados.`
            : `Cadena alterada en el registro ${check.brokenAt}.`}
        </p>
      )}
      {(error || list.error) && <p className="error">{error ?? list.error}</p>}
      <table className="compact">
        <thead><tr><th>#</th><th>Fecha</th><th>Quién</th><th>Acción</th><th>Objeto</th><th>Detalle</th></tr></thead>
        <tbody>
          {(list.data ?? []).map((a) => (
            <tr key={a.id}>
              <td>{a.id}</td>
              <td className="small">{dateTime(a.at)}</td>
              <td>{a.actor_name ?? 'Sistema'}</td>
              <td>{a.action}</td>
              <td>{a.entity} {a.entity_id ?? ''}</td>
              <td className="mono small detail-json">{JSON.stringify(a.data)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
