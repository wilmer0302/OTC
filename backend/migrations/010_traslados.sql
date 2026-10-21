-- Fase 4 · Traslados entre cuentas propias.
-- Un traslado aparta su monto en la cuenta de origen desde que se autoriza, igual que una entrega,
-- pero no pertenece a ninguna orden: la reserva se ata solo a la transferencia.
-- Cambio no destructivo: se relaja una restricción y se agrega otra más precisa.
ALTER TABLE otc.reservations ALTER COLUMN order_id DROP NOT NULL;
ALTER TABLE otc.reservations ADD CONSTRAINT reservations_owner_check CHECK (order_id IS NOT NULL OR transfer_id IS NOT NULL);
