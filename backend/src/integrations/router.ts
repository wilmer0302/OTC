import type { ChainReader, Network } from './ports.js';

/** Un lector por red detrás de la misma interfaz: así TRON puede ser real mientras BSC sigue simulada. */
export class ChainRouter implements ChainReader {
  readonly sandbox: boolean;

  constructor(private readonly byNetwork: Record<Network, ChainReader>) {
    this.sandbox = Object.values(byNetwork).some((r) => r.sandbox);
  }

  // Propiedades y no métodos: siguen disponibles si alguien copia el objeto con { ...chain }.
  readonly sandboxFor = (network: Network) => this.byNetwork[network].sandbox;
  readonly isValidAddress: ChainReader['isValidAddress'] = (network, address) => this.byNetwork[network].isValidAddress(network, address);
  readonly usdtContract: ChainReader['usdtContract'] = (network) => this.byNetwork[network].usdtContract(network);
  readonly getTransaction: ChainReader['getTransaction'] = (network, hash) => this.byNetwork[network].getTransaction(network, hash);
  readonly listTransfers: ChainReader['listTransfers'] = (network, address, date) => this.byNetwork[network].listTransfers(network, address, date);
}
