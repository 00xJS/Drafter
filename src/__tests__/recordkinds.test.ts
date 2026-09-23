import { describe, expect, it } from 'vitest'
import { readMigrations, recordKinds, recordKindsFrom, topLevelStatements, type Migration } from './recordkinds'

// recordKinds() is what the drift tests hold the code's lists to, so it has to
// read the table the way the database fills it. The point of v3.31 is that a
// kind is added by one insert migration and nothing else, so a later insert
// has to be understood here without anyone touching a test.

const later = (sql: string): Migration[] => [...readMigrations(), { file: '20991231000000_later.sql', sql }]

describe('recordKinds replays the migrations that write record_kinds', () => {
  it('finds the seed: every kind with its audience', () => {
    const kinds = recordKinds()
    expect(kinds.get('journal')).toEqual({ personal: true, sharedDefault: null })
    expect(kinds.get('grocery')).toEqual({ personal: false, sharedDefault: null })
    expect(kinds.get('note')).toEqual({ personal: false, sharedDefault: false })
    expect(kinds.get('task')).toEqual({ personal: false, sharedDefault: true })
    expect(kinds.has('test_widget')).toBe(false)
  })

  it('understands a kind added later by an insert, with the table’s defaults for what it leaves out', () => {
    const kinds = recordKindsFrom(later(`
      -- v9.9: a budget, the household's
      insert into public.record_kinds (kind, personal, shared_default) values ('test_budget', false, null)
      on conflict (kind) do nothing;
      insert into public.record_kinds (kind) values ('test_pantry');
      insert into public.record_kinds (kind, personal) values ('test_diary', true);
      insert into record_kinds (shared_default, kind) values (false, 'test_sketch'), (true, 'test_chore');
    `))
    expect(kinds.get('test_budget')).toEqual({ personal: false, sharedDefault: null })
    expect(kinds.get('test_pantry')).toEqual({ personal: false, sharedDefault: null })
    expect(kinds.get('test_diary')).toEqual({ personal: true, sharedDefault: null })
    expect(kinds.get('test_sketch')).toEqual({ personal: false, sharedDefault: false })
    expect(kinds.get('test_chore')).toEqual({ personal: false, sharedDefault: true })
    expect(kinds.size).toBe(recordKinds().size + 5)
  })

  it('keeps the first word on a kind, as `on conflict do nothing` does', () => {
    const kinds = recordKindsFrom(later(`insert into public.record_kinds (kind, personal, shared_default) values ('task', true, null) on conflict (kind) do nothing;`))
    expect(kinds.get('task')).toEqual({ personal: false, sharedDefault: true })
  })

  it('refuses what it cannot replay rather than misreading the table', () => {
    for (const sql of [
      `update public.record_kinds set personal = true where kind = 'meal';`,
      `delete from public.record_kinds where kind = 'meal';`,
      `insert into public.record_kinds (kind, personal) values ('meal', true) on conflict (kind) do update set personal = excluded.personal;`,
      `create policy "peek" on public.record_kinds for select to authenticated using (true);`,
      `truncate public.record_kinds;`,
      // what the database itself would refuse
      `insert into public.record_kinds (kind) values ('task');`,
      `insert into public.record_kinds (kind, personal, shared_default) values ('test_secret', true, false);`,
      `insert into public.record_kinds (kind) values ('Test_budget');`,
      `insert into public.record_kinds (kind, personal) values ('test_budget', null);`,
    ]) {
      expect(() => recordKindsFrom(later(sql)), sql).toThrow()
    }
  })

  it('reads statements, not the bodies of functions or DO blocks, nor comments', () => {
    expect(topLevelStatements(`
      -- insert into public.record_kinds (kind) values ('test_ghost');
      create function f() returns void language sql as $$ delete from public.record_kinds $$;
      do $body$ begin update public.record_kinds set personal = true; end $body$;
      select 1;
    `)).toEqual(['create function f() returns void language sql as $$', 'do $$', 'select 1'])
    expect(recordKindsFrom(later(`create function f() returns void language sql as $$ delete from public.record_kinds $$;`)).size)
      .toBe(recordKinds().size)
  })
})
