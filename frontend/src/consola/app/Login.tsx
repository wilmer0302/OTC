import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { setCsrf } from '../api/client';
import { auth } from '../api/endpoints';
import type { SystemInfo } from '../api/types';
import { Button } from '../ui/Button';
import { ErrorNotice } from '../ui/Feedback';
import { Field, Input } from '../ui/Form';
import { Notice } from '../ui/Layout';

type Step = { kind: 'password' } | { kind: 'enroll'; secret: string; uri: string } | { kind: 'code' };

/**
 * Inicio de sesión en dos pasos: contraseña y código del segundo factor. La primera vez se enrola
 * el segundo factor con una aplicación de autenticación (QR o clave manual). La sesión queda en una
 * cookie HttpOnly; el navegador no guarda contraseñas, códigos ni tokens.
 */
export function Login({ system, initialStep, notice, onDone }: { system: SystemInfo | null; initialStep?: 'code'; notice?: string; onDone: () => void }) {
  const [step, setStep] = useState<Step>(initialStep === 'code' ? { kind: 'code' } : { kind: 'password' });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [qr, setQr] = useState<string | null>(null);

  useEffect(() => {
    if (step.kind === 'enroll') QRCode.toDataURL(step.uri, { margin: 1, width: 200 }).then(setQr, () => setQr(null));
  }, [step]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const submitPassword = () =>
    run(async () => {
      const r = await auth.login(username.trim(), password);
      setPassword('');
      setCsrf(r.csrfToken);
      if (r.mfa === 'ENROLL') {
        const e = await auth.enroll();
        setStep({ kind: 'enroll', secret: e.secret, uri: e.otpauthUri });
      } else setStep({ kind: 'code' });
    });

  const submitCode = () =>
    run(async () => {
      try {
        const r = await auth.verify(code);
        setCsrf(r.csrfToken);
        onDone();
      } catch (e) {
        setCode('');
        throw e;
      }
    });

  return (
    <div className="login-screen">
      <div className="login-panel">
        <div className="login-brand">
          <span className="brand-mark" aria-hidden>
            OTC
          </span>
          <div>
            <strong>Mesa OTC</strong>
            <span>Consola de operación · USDT / COP</span>
          </div>
        </div>
        {system?.mode === 'DEMO' && (
          <Notice tone="warning" title="Entorno de demostración · DATOS SIMULADOS">
            Clientes, saldos, bancos y redes son ficticios. Ningún fondo real se mueve.
          </Notice>
        )}

        {notice && step.kind === 'password' && <Notice tone="info">{notice}</Notice>}
        {step.kind === 'password' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitPassword();
            }}
          >
            <h1>Iniciar sesión</h1>
            <Field label="Usuario">{(id) => <Input id={id} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus />}</Field>
            <Field label="Contraseña">
              {(id) => <Input id={id} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />}
            </Field>
            <ErrorNotice error={error} />
            <Button type="submit" variant="primary" busy={busy} disabled={!username.trim() || !password} className="btn-block">
              Continuar
            </Button>
          </form>
        )}

        {step.kind === 'enroll' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitCode();
            }}
          >
            <h1>Activa tu segundo factor</h1>
            <p className="muted">
              Es obligatorio. Escanea el código con una aplicación de autenticación (Google Authenticator, Microsoft Authenticator, 1Password u otra) y
              escribe el código de 6 dígitos que muestre.
            </p>
            <div className="enroll">
              {qr ? <img src={qr} alt="Código QR para la aplicación de autenticación" width={200} height={200} /> : <div className="qr-placeholder" />}
              <div>
                <span className="muted small">¿No puedes escanear? Escribe esta clave:</span>
                <code className="secret">{step.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
                <span className="muted small">No la compartas ni la guardes en otro lugar. Si pierdes el teléfono, el administrador puede reiniciar tu segundo factor.</span>
              </div>
            </div>
            <CodeField code={code} setCode={setCode} />
            <ErrorNotice error={error} />
            <Button type="submit" variant="primary" busy={busy} disabled={!/^\d{6}$/.test(code)} className="btn-block">
              Activar y entrar
            </Button>
          </form>
        )}

        {step.kind === 'code' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitCode();
            }}
          >
            <h1>Código de verificación</h1>
            <p className="muted">Escribe el código de 6 dígitos de tu aplicación de autenticación.</p>
            <CodeField code={code} setCode={setCode} autoFocus />
            <ErrorNotice error={error} />
            <Button type="submit" variant="primary" busy={busy} disabled={!/^\d{6}$/.test(code)} className="btn-block">
              Entrar
            </Button>
            <Button variant="ghost" onClick={() => setStep({ kind: 'password' })} className="btn-block">
              Usar otro usuario
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}

function CodeField({ code, setCode, autoFocus }: { code: string; setCode: (v: string) => void; autoFocus?: boolean }) {
  return (
    <Field label="Código de 6 dígitos">
      {(id) => (
        <Input
          id={id}
          className="input code-input"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          autoFocus={autoFocus}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
        />
      )}
    </Field>
  );
}
