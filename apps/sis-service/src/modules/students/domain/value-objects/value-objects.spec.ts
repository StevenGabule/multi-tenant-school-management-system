import { InvariantViolation } from '../errors';
import { DateOfBirth } from './date-of-birth.vo';
import { Email } from './email.vo';
import { FullName } from './full-name.vo';
import { GuardianId } from './guardian-id.vo';
import { Phone } from './phone.vo';
import { StudentId } from './student-id.vo';

describe('StudentId', () => {
  const valid = '11111111-1111-4111-8111-111111111111';

  it('accepts a valid v4-shaped UUID', () => {
    expect(StudentId.from(valid).value).toBe(valid);
  });

  it('rejects malformed UUIDs', () => {
    expect(() => StudentId.from('not-a-uuid')).toThrow(InvariantViolation);
    expect(() => StudentId.from('')).toThrow(InvariantViolation);
  });

  it('lower-cases the UUID for canonical comparison', () => {
    const id = StudentId.from('11111111-1111-4111-8111-111111111ABC');
    expect(id.value).toBe('11111111-1111-4111-8111-111111111abc');
  });

  it('equals() compares by value', () => {
    expect(StudentId.from(valid).equals(StudentId.from(valid))).toBe(true);
  });
});

describe('GuardianId', () => {
  it('is brand-distinct from StudentId at the type system level', () => {
    // This compiles because they have the same shape AT RUNTIME, but the
    // type checker uses the __brand field to distinguish them. Sanity:
    const sId = StudentId.from('11111111-1111-4111-8111-111111111111');
    const gId = GuardianId.from('22222222-2222-4222-8222-222222222222');
    expect(sId.value).not.toBe(gId.value);
  });
});

describe('FullName', () => {
  it('builds with first + last (middle optional)', () => {
    const n = FullName.of('Ada', 'Lovelace');
    expect(n.firstName).toBe('Ada');
    expect(n.lastName).toBe('Lovelace');
    expect(n.middleName).toBeNull();
  });

  it('trims whitespace on all parts', () => {
    const n = FullName.of('  Ada  ', '  Lovelace  ', '  King  ');
    expect(n.firstName).toBe('Ada');
    expect(n.middleName).toBe('King');
  });

  it('rejects empty first or last name', () => {
    expect(() => FullName.of('', 'Lovelace')).toThrow(InvariantViolation);
    expect(() => FullName.of('Ada', '   ')).toThrow(InvariantViolation);
  });

  it('rejects ridiculously long parts', () => {
    expect(() => FullName.of('A'.repeat(101), 'B')).toThrow(InvariantViolation);
  });

  it('display() omits doubled spaces when middle is absent', () => {
    expect(FullName.of('Ada', 'Lovelace').display()).toBe('Ada Lovelace');
    expect(FullName.of('Ada', 'Lovelace', 'King').display()).toBe(
      'Ada King Lovelace',
    );
  });

  it('formal() returns "Last, First"', () => {
    expect(FullName.of('Ada', 'Lovelace').formal()).toBe('Lovelace, Ada');
  });

  it('initials()', () => {
    expect(FullName.of('Ada', 'Lovelace').initials()).toBe('AL');
    expect(FullName.of('Ada', 'Lovelace', 'King').initials()).toBe('AKL');
  });
});

describe('DateOfBirth', () => {
  const now = new Date('2026-05-10T00:00:00.000Z');

  it('accepts a valid ISO date string', () => {
    const dob = DateOfBirth.from('2010-06-15', now);
    expect(dob.toISODate()).toBe('2010-06-15');
  });

  it('rejects non-ISO formats', () => {
    expect(() => DateOfBirth.from('06/15/2010', now)).toThrow(InvariantViolation);
    expect(() => DateOfBirth.from('2010-6-15', now)).toThrow(InvariantViolation);
  });

  it('rejects future dates', () => {
    expect(() => DateOfBirth.from('2099-01-01', now)).toThrow(
      /must be in the past/,
    );
  });

  it('rejects pre-1900 dates as likely typos', () => {
    expect(() => DateOfBirth.from('1850-01-01', now)).toThrow(/before 1900/);
  });

  it('ageInYears handles the before/after-birthday-this-year edge', () => {
    // born June 15 2010; "now" is May 10 2026 → age 15 (birthday hasn't passed yet)
    expect(DateOfBirth.from('2010-06-15', now).ageInYears(now)).toBe(15);
    // born May 9 2010 → birthday passed → age 16
    expect(DateOfBirth.from('2010-05-09', now).ageInYears(now)).toBe(16);
    // born May 10 2010 → birthday today → age 16 (>=, not >)
    expect(DateOfBirth.from('2010-05-10', now).ageInYears(now)).toBe(16);
  });
});

describe('Email', () => {
  it('lower-cases on storage', () => {
    expect(Email.from('Foo@SCHOOL.EDU').value).toBe('foo@school.edu');
  });

  it('rejects malformed values', () => {
    expect(() => Email.from('')).toThrow(InvariantViolation);
    expect(() => Email.from('no-at-sign')).toThrow(InvariantViolation);
    expect(() => Email.from('a@b')).toThrow(InvariantViolation); // tld too short
    expect(() => Email.from('a@b.c')).toThrow(InvariantViolation); // tld too short
  });

  it('exposes the domain portion', () => {
    expect(Email.from('foo@school.edu').domain()).toBe('school.edu');
  });
});

describe('Phone', () => {
  it('strips formatting on storage', () => {
    expect(Phone.from('+1 (555) 123-4567').value).toBe('15551234567');
    expect(Phone.from('555.123.4567').value).toBe('5551234567');
  });

  it('rejects too-short or too-long', () => {
    expect(() => Phone.from('123')).toThrow(InvariantViolation);
    expect(() => Phone.from('1'.repeat(16))).toThrow(InvariantViolation);
  });

  it('rejects empty', () => {
    expect(() => Phone.from('')).toThrow(InvariantViolation);
  });
});
