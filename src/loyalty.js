// Pure loyalty math — unit-tested. No DB / no I/O here.
// All amounts in paise (integer). Points are integers, never floats.

export function calcPointsEarn({ programType, rules, amountPaise }) {
  const r = rules || {};
  if (amountPaise != null && (!Number.isInteger(amountPaise) || amountPaise <= 0)) {
    throw new Error('invalid_amount');
  }
  switch (programType) {
    case 'points': {
      // e.g. { pointsPer100Rs: 10 } => 10 pts per Rs.100 slab
      const per100 = r.pointsPer100Rs ?? 10;
      if (per100 <= 0) throw new Error('invalid_rules');
      const slabs = Math.floor((amountPaise ?? 0) / 10000);
      return { points: slabs * per100, stamps: 0 };
    }
    case 'spend': {
      // { thresholdPaise, bonusPoints }
      const threshold = r.thresholdPaise ?? 50000; // Rs.500 default
      const bonus = r.bonusPoints ?? 20;
      if ((amountPaise ?? 0) >= threshold) return { points: bonus, stamps: 0 };
      return { points: 0, stamps: 0 };
    }
    case 'visit':
    case 'count':
    case 'star': {
      // 1 stamp/star per eligible visit, amount ignored
      return { points: 0, stamps: 1 };
    }
    case 'custom': {
      return { points: r.flatPoints ?? 0, stamps: r.flatStamps ?? 0 };
    }
    default:
      throw new Error('unknown_program_type');
  }
}

// Simplified correct points calc (replaces confusing line above for points type)
export function calcPointsEarnClean({ pointsPer100Rs = 10, amountPaise = 0 }) {
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) throw new Error('invalid_amount');
  const hundreds = Math.floor(amountPaise / 10000); // number of Rs.100 slabs
  return hundreds * pointsPer100Rs;
}

export function canRedeem({ balance, reward, redemptionCount = 0 }) {
  if (!reward.active) return { ok: false, reason: 'reward_inactive' };
  const now = new Date();
  if (reward.start_at && new Date(reward.start_at) > now) return { ok: false, reason: 'not_started' };
  if (reward.end_at && new Date(reward.end_at) < now) return { ok: false, reason: 'expired' };
  if ((balance.points ?? 0) < (reward.cost_points ?? 0)) return { ok: false, reason: 'insufficient_points' };
  if ((balance.stamps ?? 0) < (reward.cost_stamps ?? 0)) return { ok: false, reason: 'insufficient_stamps' };
  if (reward.per_customer_limit != null && redemptionCount >= reward.per_customer_limit) return { ok: false, reason: 'per_customer_limit' };
  return { ok: true };
}

// Phase 2: strict server-side rule validation. Returns {ok} or {ok:false, error}.
export function validateProgramRules(type, rules = {}) {
  const r = rules || {};
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  switch (type) {
    case 'points': {
      const v = r.pointsPer100Rs ?? 10;
      if (!num(v) || !Number.isInteger(v) || v < 1 || v > 100) return { ok: false, error: 'pointsPer100Rs must be integer 1..100' };
      return { ok: true, rules: { pointsPer100Rs: v } };
    }
    case 'spend': {
      const t = r.thresholdPaise ?? 50000, b = r.bonusPoints ?? 20;
      if (!num(t) || !Number.isInteger(t) || t <= 0 || t > 100000000) return { ok: false, error: 'thresholdPaise invalid' };
      if (!num(b) || !Number.isInteger(b) || b < 0 || b > 10000) return { ok: false, error: 'bonusPoints must be 0..10000' };
      return { ok: true, rules: { thresholdPaise: t, bonusPoints: b } };
    }
    case 'visit':
    case 'count':
    case 'star': {
      const need = r.stampsToReward ?? r.servicesToReward ?? 5;
      if (!num(need) || !Number.isInteger(need) || need < 2 || need > 50) return { ok: false, error: 'threshold must be integer 2..50' };
      return { ok: true, rules: { stampsToReward: need } };
    }
    case 'custom': {
      const p = r.flatPoints ?? 0, s = r.flatStamps ?? 0;
      if (!num(p) || !Number.isInteger(p) || p < 0 || p > 10000) return { ok: false, error: 'flatPoints must be 0..10000' };
      if (!num(s) || !Number.isInteger(s) || s < 0 || s > 100) return { ok: false, error: 'flatStamps must be 0..100' };
      if (p === 0 && s === 0) return { ok: false, error: 'custom must award something' };
      return { ok: true, rules: { flatPoints: p, flatStamps: s } };
    }
    default:
      return { ok: false, error: 'unknown_program_type' };
  }
}

export function validateRewardInput({ cost_points = 0, cost_stamps = 0, min_spend = 0, per_customer_limit = null, start_at = null, end_at = null }) {
  if (!Number.isInteger(cost_points) || !Number.isInteger(cost_stamps) || cost_points < 0 || cost_stamps < 0) return { ok: false, error: 'bad_cost' };
  if (cost_points === 0 && cost_stamps === 0) return { ok: false, error: 'reward must cost something' };
  if (cost_points > 100000 || cost_stamps > 1000) return { ok: false, error: 'cost_too_high' };
  if (!Number.isInteger(min_spend) || min_spend < 0 || min_spend > 100000000) return { ok: false, error: 'bad_min_spend' };
  if (per_customer_limit != null && (!Number.isInteger(per_customer_limit) || per_customer_limit < 1 || per_customer_limit > 100)) return { ok: false, error: 'bad_per_customer_limit' };
  if (start_at && Number.isNaN(Date.parse(start_at))) return { ok: false, error: 'bad_start_at' };
  if (end_at && Number.isNaN(Date.parse(end_at))) return { ok: false, error: 'bad_end_at' };
  if (start_at && end_at && Date.parse(start_at) >= Date.parse(end_at)) return { ok: false, error: 'end_before_start' };
  return { ok: true };
}

export function isValidIndianMobile(phone) {
  return /^[6-9]\d{9}$/.test(String(phone).replace(/^\+91/, '').replace(/\s/g, ''));
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || '').trim());
}
