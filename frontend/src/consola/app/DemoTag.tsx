import { SimulatedTag } from '../ui/Badge';
import { isDemo, useSession } from './session';

/** Etiqueta «DATOS SIMULADOS» junto a cifras y registros cuando el sistema corre en modo DEMO. */
export function DemoTag() {
  const { system } = useSession();
  return isDemo(system) ? <SimulatedTag /> : null;
}
