import { InvariantViolation } from '../errors';
import { DateOfBirth } from '../value-objects/date-of-birth.vo';
import { Email } from '../value-objects/email.vo';
import { FullName } from '../value-objects/full-name.vo';
import { Phone } from '../value-objects/phone.vo';
import { Student } from './student.entity';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-05-10T12:00:00.000Z');

function newStudent() {
  return Student.create({
    tenantId: TENANT_ID,
    name: FullName.of('Ada', 'Lovelace'),
    dateOfBirth: DateOfBirth.from('2010-12-10', NOW),
    email: Email.from('ada@school.edu'),
  });
}

describe('Student.create', () => {
  it('returns a Student with a generated UUID', () => {
    const s = newStudent();
    expect(s.id.value).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(s.tenantId).toBe(TENANT_ID);
    expect(s.name.formal()).toBe('Lovelace, Ada');
    expect(s.email?.value).toBe('ada@school.edu');
    expect(s.isDeleted()).toBe(false);
  });

  it('trims optional externalId and gender', () => {
    const s = Student.create({
      tenantId: TENANT_ID,
      name: FullName.of('Ada', 'Lovelace'),
      dateOfBirth: DateOfBirth.from('2010-12-10', NOW),
      externalId: '  STU-001  ',
      gender: '  female  ',
    });
    expect(s.externalId).toBe('STU-001');
    expect(s.gender).toBe('female');
  });
});

describe('Student.rename', () => {
  it('updates the name and touches updatedAt', async () => {
    const s = newStudent();
    const before = s.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    s.rename(FullName.of('Augusta Ada', 'King-Lovelace'));
    expect(s.name.firstName).toBe('Augusta Ada');
    expect(s.name.lastName).toBe('King-Lovelace');
    expect(s.updatedAt.getTime()).toBeGreaterThan(before.getTime());
  });

  it('is a no-op if the new name equals the old', () => {
    const s = newStudent();
    const before = s.updatedAt;
    s.rename(FullName.of('Ada', 'Lovelace'));
    expect(s.updatedAt).toBe(before);
  });

  it('refuses to rename a deleted student', () => {
    const s = newStudent();
    s.softDelete();
    expect(() => s.rename(FullName.of('X', 'Y'))).toThrow(InvariantViolation);
  });
});

describe('Student.updateContact', () => {
  it('updates email and phone independently (undefined = unchanged)', () => {
    const s = newStudent();
    s.updateContact({ phone: Phone.from('555-123-4567') });
    expect(s.email?.value).toBe('ada@school.edu'); // untouched
    expect(s.phone?.value).toBe('5551234567');

    s.updateContact({ email: null });
    expect(s.email).toBeNull();
    expect(s.phone?.value).toBe('5551234567'); // still untouched
  });

  it('refuses to update a deleted student', () => {
    const s = newStudent();
    s.softDelete();
    expect(() => s.updateContact({ email: null })).toThrow(InvariantViolation);
  });
});

describe('Student.softDelete + restore', () => {
  it('softDelete sets deletedAt + isDeleted', () => {
    const s = newStudent();
    expect(s.isDeleted()).toBe(false);
    s.softDelete(NOW);
    expect(s.isDeleted()).toBe(true);
    expect(s.deletedAt?.toISOString()).toBe(NOW.toISOString());
  });

  it('softDelete is idempotent — second call keeps the original timestamp', () => {
    const s = newStudent();
    s.softDelete(NOW);
    const first = s.deletedAt;
    s.softDelete(new Date(NOW.getTime() + 86400_000));
    expect(s.deletedAt).toBe(first);
  });

  it('restore clears deletedAt; second call is a no-op', () => {
    const s = newStudent();
    s.softDelete();
    s.restore();
    expect(s.isDeleted()).toBe(false);
    expect(s.deletedAt).toBeNull();
    s.restore(); // no-op
    expect(s.isDeleted()).toBe(false);
  });
});

describe('Student.toSnapshot ↔ reconstitute', () => {
  it('round-trips through a snapshot without losing data', () => {
    const s1 = newStudent();
    s1.recordExternalId('STU-7');
    s1.updateContact({ phone: Phone.from('5551112222') });
    const snap = s1.toSnapshot();
    const s2 = Student.reconstitute(snap);

    expect(s2.id.value).toBe(s1.id.value);
    expect(s2.tenantId).toBe(s1.tenantId);
    expect(s2.name.equals(s1.name)).toBe(true);
    expect(s2.dateOfBirth.toISODate()).toBe(s1.dateOfBirth.toISODate());
    expect(s2.email?.value).toBe(s1.email?.value);
    expect(s2.phone?.value).toBe(s1.phone?.value);
    expect(s2.externalId).toBe(s1.externalId);
    expect(s2.isDeleted()).toBe(false);
  });

  it('reconstitute preserves a soft-deleted state', () => {
    const s1 = newStudent();
    s1.softDelete(NOW);
    const s2 = Student.reconstitute(s1.toSnapshot());
    expect(s2.isDeleted()).toBe(true);
  });
});
