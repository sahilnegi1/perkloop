import { db } from '../src/db.js';
import { v4 as uuid } from 'uuid';

// Honest seed: clearly-labeled demo businesses for Noida/NCR discovery. No fake testimonials/partnerships.
const demo = [
  { name: 'Brew Loop Cafe — Sector 62', category: 'cafe', address: 'G-12, Sector 62 Market', city: 'Noida', pincode: '201301', program: { type: 'visit', name: 'Coffee stamps', rules: { stampsToReward: 5 } }, reward: { title: 'Free cappuccino', cost_stamps: 5 } },
  { name: 'Snip & Shine Salon — Sector 18', category: 'salon', address: 'P-4, Sector 18 Market', city: 'Noida', pincode: '201301', program: { type: 'count', name: 'Haircut count', rules: { servicesToReward: 5 } }, reward: { title: '20% off haircut', cost_stamps: 5 } },
  { name: 'Daily Fresh Supermarket — Gr. Noida', category: 'supermarket', address: 'Plot 7, Jagat Farm', city: 'Greater Noida', pincode: '201308', program: { type: 'points', name: 'Spend points', rules: { pointsPer100Rs: 10 } }, reward: { title: 'Rs.100 off Rs.999', cost_points: 100 } },
];

for (const d of demo) {
  const exists = db.prepare('SELECT 1 FROM businesses WHERE name=?').get(d.name);
  if (exists) continue;
  const bId = uuid(), owner = uuid(), oId = uuid(), pId = uuid(), rId = uuid();
  db.prepare(`INSERT INTO users (id, role, name, email) VALUES (?, 'merchant', ?, ?)`).run(owner, d.name + ' owner', `owner-${bId.slice(0, 8)}@example.in`);
  db.prepare(`INSERT INTO businesses (id, owner_user_id, name, category, address, city, state, pincode) VALUES (?,?,?,?,?,?,?,?)`)
    .run(bId, owner, d.name, d.category, d.address, d.city, 'Uttar Pradesh', d.pincode);
  db.prepare(`INSERT INTO memberships (user_id, business_id, role) VALUES (?,?,'owner')`).run(owner, bId);
  db.prepare(`INSERT INTO outlets (id, business_id, name, address, city, static_token) VALUES (?,?,?,?,?,?)`)
    .run(oId, bId, 'Main outlet', d.address, d.city, 'ST-' + bId.slice(0, 12));
  db.prepare(`INSERT INTO loyalty_programs (id, business_id, type, name, status, rules_json) VALUES (?,?,?,?,?,?)`)
    .run(pId, bId, d.program.type, d.program.name, 'active', JSON.stringify(d.program.rules));
  db.prepare(`INSERT INTO rewards (id, business_id, program_id, title, description, cost_points, cost_stamps) VALUES (?,?,?,?,?,?,?)`)
    .run(rId, bId, pId, d.reward.title, 'Seed offer — edit in merchant dashboard.', d.reward.cost_points || 0, d.reward.cost_stamps || 0);
  console.log('seeded', d.name);
}
console.log('Seed done.');
