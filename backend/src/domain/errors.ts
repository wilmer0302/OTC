// Errores de dominio con código estable y mensaje para el usuario.
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus = 409,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new DomainError('NOT_FOUND', `${what} no existe`, 404);
export const forbidden = (message: string) => new DomainError('FORBIDDEN', message, 403);
export const invalid = (message: string) => new DomainError('INVALID', message, 400);
