import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PROFILE_NAME,
  MAX_PROFILES,
  activateProfile,
  activeFields,
  createProfile,
  deleteProfile,
  isEnvelope,
  toEnvelope,
  updateProfile,
} from '@/lib/accounts/profiles';

const flat = { domain: 'ai', education: 'bachelor', python_level: 2 };

describe('多档案信封', () => {
  it('旧扁平画像包成一条默认档案，字段一个不动', () => {
    const env = toEnvelope(flat);
    expect(env.profiles).toHaveLength(1);
    expect(env.profiles[0].name).toBe(DEFAULT_PROFILE_NAME);
    expect(env.profiles[0].fields).toEqual(flat);
    expect(env.activeId).toBe(env.profiles[0].id);
  });

  it('activeFields 把信封拆回扁平画像 —— 既有读取方无感知', () => {
    expect(activeFields(toEnvelope(flat))).toEqual(flat);
  });

  it('没填过画像时 activeFields 给 null，不是空对象', () => {
    // 既有代码用 `profile ? A : B` 判「填没填」，空对象会被当成填过。
    expect(activeFields(toEnvelope(null))).toBeNull();
    expect(activeFields(toEnvelope(undefined))).toBeNull();
  });

  it('迁移是幂等的', () => {
    const once = toEnvelope(flat);
    expect(toEnvelope(once)).toBe(once);
    expect(isEnvelope(once)).toBe(true);
  });

  it('新建即切换', () => {
    const env = toEnvelope(flat);
    const r = createProfile(env, '转岗后端', { domain: 'ai', python_level: 4 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.env.profiles).toHaveLength(2);
    expect(r.env.activeId).toBe(r.id);
    expect(activeFields(r.env)).toEqual({ domain: 'ai', python_level: 4 });
  });

  it('重名、空名、超上限都挡住', () => {
    let env = toEnvelope(flat);
    expect(createProfile(env, DEFAULT_PROFILE_NAME)).toMatchObject({ ok: false });
    expect(createProfile(env, '   ')).toMatchObject({ ok: false });
    for (let i = env.profiles.length; i < MAX_PROFILES; i++) {
      const r = createProfile(env, `档案${i}`);
      expect(r.ok).toBe(true);
      if (r.ok) env = r.env;
    }
    expect(createProfile(env, '再来一个')).toMatchObject({ ok: false });
  });

  it('改字段是整体替换，不是浅合并 —— 否则清空某项永远不生效', () => {
    const env = toEnvelope(flat);
    const r = updateProfile(env, env.activeId, { fields: { domain: 'iotdb' } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(activeFields(r.env)).toEqual({ domain: 'iotdb' });
    expect(activeFields(r.env)).not.toHaveProperty('python_level');
  });

  it('换知识库就是改字段 —— 落在服务端，不是本地快照', () => {
    const env = toEnvelope({ ...flat, corpus: 'ai' });
    const r = updateProfile(env, env.activeId, { fields: { ...flat, corpus: 'iotdb' } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((activeFields(r.env) as { corpus?: string }).corpus).toBe('iotdb');
  });

  it('最后一份档案删不掉；删掉当前档案会落到第一份', () => {
    const env = toEnvelope(flat);
    expect(deleteProfile(env, env.activeId)).toMatchObject({ ok: false });
    const made = createProfile(env, '第二份');
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const del = deleteProfile(made.env, made.id); // 删的正是当前档案
    expect(del.ok).toBe(true);
    if (!del.ok) return;
    expect(del.env.profiles).toHaveLength(1);
    expect(del.env.activeId).toBe(del.env.profiles[0].id);
  });

  it('切换到不存在的档案要报错，不静默', () => {
    const env = toEnvelope(flat);
    expect(activateProfile(env, 'nope')).toMatchObject({ ok: false });
  });
});
