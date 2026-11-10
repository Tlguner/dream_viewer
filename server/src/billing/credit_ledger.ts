import crypto from 'crypto';

export type ReservationStatus = 'PENDING' | 'COMMITTED' | 'RELEASED';

export interface CreditReservation {
  id: string;
  userId: string;
  amount: number;
  referenceId: string;
  status: ReservationStatus;
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, any>;
}

export interface UserBalance {
  credits: number;
  reservedCredits: number;
  availableCredits: number;
}

export class InsufficientCreditsError extends Error {
  constructor(public readonly available: number, public readonly requested: number) {
    super(`Insufficient available credits. Requested: ${requested}, Available: ${available}`);
    this.name = 'InsufficientCreditsError';
  }
}

export class ReservationNotFoundError extends Error {
  constructor(public readonly reservationId: string) {
    super(`Credit reservation '${reservationId}' not found.`);
    this.name = 'ReservationNotFoundError';
  }
}

export class ReservationAlreadyProcessedError extends Error {
  constructor(public readonly reservationId: string, public readonly currentStatus: ReservationStatus, public readonly attemptedAction: string) {
    super(`Cannot ${attemptedAction} reservation '${reservationId}' because it is already '${currentStatus}'.`);
    this.name = 'ReservationAlreadyProcessedError';
  }
}

export class InvalidReservationAmountError extends Error {
  constructor(public readonly amount: number) {
    super(`Reservation amount must be a positive integer greater than 0. Received: ${amount}`);
    this.name = 'InvalidReservationAmountError';
  }
}

/**
 * CreditLedger
 * 
 * Manages atomic credit reservations, commitments, and refunds.
 * Guarantees that:
 * 1. Reservations can never be committed or released more than once.
 * 2. Released reservations cannot be committed, and committed reservations cannot be released.
 * 3. Reserved credits are strictly tracked by a unique reservation ID.
 * 4. Overdrawing beyond available balance (credits - reservedCredits) is impossible.
 */
export class CreditLedger {
  private userBalances: Map<string, { credits: number; reservedCredits: number }> = new Map();
  private reservations: Map<string, CreditReservation> = new Map();

  constructor(initialBalances?: Record<string, { credits: number; reservedCredits?: number }>) {
    if (initialBalances) {
      for (const [userId, bal] of Object.entries(initialBalances)) {
        this.setUserBalance(userId, bal.credits, bal.reservedCredits || 0);
      }
    }
  }

  public setUserBalance(userId: string, credits: number, reservedCredits: number = 0): void {
    if (credits < 0 || reservedCredits < 0) {
      throw new Error(`Credits and reserved credits must be non-negative.`);
    }
    this.userBalances.set(userId, { credits, reservedCredits });
  }

  public getBalance(userId: string): UserBalance {
    const bal = this.userBalances.get(userId) || { credits: 0, reservedCredits: 0 };
    return {
      credits: bal.credits,
      reservedCredits: bal.reservedCredits,
      availableCredits: Math.max(0, bal.credits - bal.reservedCredits)
    };
  }

  /**
   * Atomically reserve credits for an operation before queueing it.
   */
  public reserve(userId: string, amount: number, referenceId: string, metadata?: Record<string, any>): CreditReservation {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new InvalidReservationAmountError(amount);
    }

    const bal = this.userBalances.get(userId);
    if (!bal) {
      throw new InsufficientCreditsError(0, amount);
    }

    const available = bal.credits - bal.reservedCredits;
    if (available < amount) {
      throw new InsufficientCreditsError(available, amount);
    }

    // Atomically increment reserved credits
    bal.reservedCredits += amount;

    const reservationId = `res_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const reservation: CreditReservation = {
      id: reservationId,
      userId,
      amount,
      referenceId,
      status: 'PENDING',
      createdAt: now,
      updatedAt: now,
      metadata
    };

    this.reservations.set(reservationId, reservation);
    return reservation;
  }

  /**
   * Finalize the deduction of credits upon verified successful completion.
   */
  public commit(reservationId: string): CreditReservation {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) {
      throw new ReservationNotFoundError(reservationId);
    }

    if (reservation.status !== 'PENDING') {
      throw new ReservationAlreadyProcessedError(reservationId, reservation.status, 'commit');
    }

    const bal = this.userBalances.get(reservation.userId);
    if (!bal) {
      throw new Error(`User '${reservation.userId}' not found during commit.`);
    }

    // Deduct both actual credits and reserved credits
    bal.credits = Math.max(0, bal.credits - reservation.amount);
    bal.reservedCredits = Math.max(0, bal.reservedCredits - reservation.amount);

    reservation.status = 'COMMITTED';
    reservation.updatedAt = Date.now();

    return reservation;
  }

  /**
   * Release and refund the reserved credits upon operation failure or cancellation.
   */
  public release(reservationId: string): CreditReservation {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) {
      throw new ReservationNotFoundError(reservationId);
    }

    if (reservation.status !== 'PENDING') {
      throw new ReservationAlreadyProcessedError(reservationId, reservation.status, 'release');
    }

    const bal = this.userBalances.get(reservation.userId);
    if (!bal) {
      throw new Error(`User '${reservation.userId}' not found during release.`);
    }

    // Release only the reserved credits without modifying actual credits
    bal.reservedCredits = Math.max(0, bal.reservedCredits - reservation.amount);

    reservation.status = 'RELEASED';
    reservation.updatedAt = Date.now();

    return reservation;
  }

  public getReservation(reservationId: string): CreditReservation | undefined {
    return this.reservations.get(reservationId);
  }

  public getReservationsForReference(referenceId: string): CreditReservation[] {
    const results: CreditReservation[] = [];
    for (const res of this.reservations.values()) {
      if (res.referenceId === referenceId) {
        results.push(res);
      }
    }
    return results;
  }
}
