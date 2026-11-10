import { describe, it, expect, beforeEach } from 'vitest';
import {
  CreditLedger,
  InsufficientCreditsError,
  InvalidReservationAmountError,
  ReservationAlreadyProcessedError,
  ReservationNotFoundError
} from '../src/billing/credit_ledger.js';

describe('CreditLedger Unit Tests', () => {
  let ledger: CreditLedger;
  const userId = 'usr_test_123';

  beforeEach(() => {
    ledger = new CreditLedger({
      [userId]: { credits: 10, reservedCredits: 0 }
    });
  });

  describe('Initialization & Balance Queries', () => {
    it('should return initial balances correctly', () => {
      const balance = ledger.getBalance(userId);
      expect(balance.credits).toBe(10);
      expect(balance.reservedCredits).toBe(0);
      expect(balance.availableCredits).toBe(10);
    });

    it('should return zero balance for unknown users', () => {
      const balance = ledger.getBalance('usr_unknown');
      expect(balance.credits).toBe(0);
      expect(balance.reservedCredits).toBe(0);
      expect(balance.availableCredits).toBe(0);
    });
  });

  describe('Reservation (reserve)', () => {
    it('should successfully reserve credits and adjust available balance', () => {
      const res = ledger.reserve(userId, 2, 'dream_1');
      expect(res.id).toMatch(/^res_/);
      expect(res.amount).toBe(2);
      expect(res.status).toBe('PENDING');

      const balance = ledger.getBalance(userId);
      expect(balance.credits).toBe(10);
      expect(balance.reservedCredits).toBe(2);
      expect(balance.availableCredits).toBe(8);
    });

    it('should reject reservations exceeding available balance', () => {
      expect(() => ledger.reserve(userId, 11, 'dream_1')).toThrow(InsufficientCreditsError);

      ledger.reserve(userId, 8, 'dream_1');
      // Now only 2 available
      expect(() => ledger.reserve(userId, 3, 'dream_2')).toThrow(InsufficientCreditsError);
    });

    it('should reject invalid or non-positive amounts', () => {
      expect(() => ledger.reserve(userId, 0, 'dream_1')).toThrow(InvalidReservationAmountError);
      expect(() => ledger.reserve(userId, -1, 'dream_1')).toThrow(InvalidReservationAmountError);
      expect(() => ledger.reserve(userId, 1.5, 'dream_1')).toThrow(InvalidReservationAmountError);
    });
  });

  describe('Commit (commit)', () => {
    it('should finalize credit deduction and decrement reserved credits', () => {
      const res = ledger.reserve(userId, 1, 'scene_1');
      const committed = ledger.commit(res.id);

      expect(committed.status).toBe('COMMITTED');

      const balance = ledger.getBalance(userId);
      expect(balance.credits).toBe(9);
      expect(balance.reservedCredits).toBe(0);
      expect(balance.availableCredits).toBe(9);
    });

    it('should prevent double commit (idempotency/accounting protection)', () => {
      const res = ledger.reserve(userId, 1, 'scene_1');
      ledger.commit(res.id);

      expect(() => ledger.commit(res.id)).toThrow(ReservationAlreadyProcessedError);

      const balance = ledger.getBalance(userId);
      expect(balance.credits).toBe(9);
      expect(balance.reservedCredits).toBe(0);
    });

    it('should throw when committing non-existent reservation', () => {
      expect(() => ledger.commit('res_non_existent')).toThrow(ReservationNotFoundError);
    });
  });

  describe('Release / Refund (release)', () => {
    it('should release reserved credits without altering base credits', () => {
      const res = ledger.reserve(userId, 1, 'scene_1');
      const released = ledger.release(res.id);

      expect(released.status).toBe('RELEASED');

      const balance = ledger.getBalance(userId);
      expect(balance.credits).toBe(10);
      expect(balance.reservedCredits).toBe(0);
      expect(balance.availableCredits).toBe(10);
    });

    it('should prevent double release (cannot release same reservation twice)', () => {
      const res = ledger.reserve(userId, 1, 'scene_1');
      ledger.release(res.id);

      expect(() => ledger.release(res.id)).toThrow(ReservationAlreadyProcessedError);

      const balance = ledger.getBalance(userId);
      expect(balance.credits).toBe(10);
      expect(balance.reservedCredits).toBe(0);
    });

    it('should throw when releasing non-existent reservation', () => {
      expect(() => ledger.release('res_non_existent')).toThrow(ReservationNotFoundError);
    });
  });

  describe('Cross-Operation Invariants & Isolation', () => {
    it('should reject releasing an already committed reservation', () => {
      const res = ledger.reserve(userId, 1, 'scene_1');
      ledger.commit(res.id);

      expect(() => ledger.release(res.id)).toThrow(ReservationAlreadyProcessedError);
    });

    it('should reject committing an already released reservation', () => {
      const res = ledger.reserve(userId, 1, 'scene_1');
      ledger.release(res.id);

      expect(() => ledger.commit(res.id)).toThrow(ReservationAlreadyProcessedError);
    });

    it('should accurately handle multi-scene partial failure accounting', () => {
      // User starts with 10 credits
      // Scene 1 reserves 1 credit
      const res1 = ledger.reserve(userId, 1, 'dream_1_scene_1');
      // Scene 2 reserves 1 credit
      const res2 = ledger.reserve(userId, 1, 'dream_1_scene_2');

      expect(ledger.getBalance(userId)).toEqual({
        credits: 10,
        reservedCredits: 2,
        availableCredits: 8
      });

      // Scene 1 succeeds -> commit
      ledger.commit(res1.id);
      expect(ledger.getBalance(userId)).toEqual({
        credits: 9,
        reservedCredits: 1,
        availableCredits: 8
      });

      // Scene 2 fails -> release
      ledger.release(res2.id);
      expect(ledger.getBalance(userId)).toEqual({
        credits: 9,
        reservedCredits: 0,
        availableCredits: 9
      });

      // Re-releasing scene 2 MUST NOT touch scene 1 or balance
      expect(() => ledger.release(res2.id)).toThrow(ReservationAlreadyProcessedError);
      expect(ledger.getBalance(userId).reservedCredits).toBe(0);
      expect(ledger.getBalance(userId).credits).toBe(9);
    });
  });
});
