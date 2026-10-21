import { Component, type ReactNode } from 'react';

/** Si una pantalla falla al dibujarse, se muestra un aviso y el resto de la consola sigue funcionando. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="notice tone-danger" role="alert">
        <strong>Esta pantalla no se pudo mostrar</strong>
        <div>No se perdió ningún dato: la operación vive en el servidor. Recarga la página; si se repite, avisa a soporte.</div>
        <div className="notice-ref">{this.state.error.message}</div>
      </div>
    );
  }
}
