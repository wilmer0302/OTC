import { useState } from 'react';
import { api } from '../api';
import type { User } from '../App';
import { useAction, useLoad } from '../hooks';

const EMPTY = { name: '', documentId: '', kycStatus: 'PENDIENTE', bankAccount: '', tronAddress: '', bscAddress: '' };

export default function Clients({ user }: { user: User }) {
  const list = useLoad<any[]>('/counterparties');
  const [form, setForm] = useState(EMPTY);
  const [open, setOpen] = useState(false);
  const { busy, error, run } = useAction();
  const isAdmin = user.roles.includes('ADMIN');
  const canCreate = isAdmin || user.roles.includes('OPERADOR');

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      await api('POST', '/counterparties', form, true);
      setForm(EMPTY);
      setOpen(false);
      list.reload();
    });
  };

  const setKyc = (id: string, kycStatus: string) =>
    run(async () => {
      await api('PATCH', `/counterparties/${id}/kyc`, { kycStatus });
      list.reload();
    });

  return (
    <section>
      <h2>Clientes</h2>
      {canCreate && !open && <button onClick={() => setOpen(true)}>Nuevo cliente</button>}
      {open && (
        <form className="card narrow" onSubmit={create}>
          <label>Nombre o razón social<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label>Documento (NIT o cédula)<input value={form.documentId} onChange={(e) => setForm({ ...form, documentId: e.target.value })} /></label>
          <label>Cuenta bancaria<input value={form.bankAccount} onChange={(e) => setForm({ ...form, bankAccount: e.target.value })} /></label>
          <label>Dirección Tron<input className="mono" value={form.tronAddress} onChange={(e) => setForm({ ...form, tronAddress: e.target.value })} /></label>
          <label>Dirección BSC<input className="mono" value={form.bscAddress} onChange={(e) => setForm({ ...form, bscAddress: e.target.value })} /></label>
          <p className="muted small">El cliente queda con KYC pendiente hasta que un administrador lo apruebe.</p>
          {error && <p className="error">{error}</p>}
          <div className="actions">
            <button className="primary" disabled={busy || !form.name || !form.documentId}>Guardar</button>
            <button type="button" onClick={() => setOpen(false)}>Cancelar</button>
          </div>
        </form>
      )}
      {!open && error && <p className="error">{error}</p>}
      <table>
        <thead>
          <tr><th>Nombre</th><th>Documento</th><th>KYC</th><th>Cuenta bancaria</th><th>Tron</th><th>BSC</th></tr>
        </thead>
        <tbody>
          {(list.data ?? []).map((c) => (
            <tr key={c.id}>
              <td>{c.name}</td>
              <td>{c.document_id}</td>
              <td>
                {isAdmin ? (
                  <select value={c.kyc_status} disabled={busy} onChange={(e) => setKyc(c.id, e.target.value)}>
                    <option>PENDIENTE</option><option>APROBADO</option><option>BLOQUEADO</option>
                  </select>
                ) : (
                  c.kyc_status
                )}
              </td>
              <td>{c.bank_account ?? '—'}</td>
              <td className="mono small">{c.tron_address ?? '—'}</td>
              <td className="mono small">{c.bsc_address ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
