import { EmptyState, PageHeader } from '../ui/Layout';

export function Pending() {
  return (
    <>
      <PageHeader title="Módulo en construcción" />
      <EmptyState title="Este módulo se habilita en la siguiente entrega." />
    </>
  );
}
