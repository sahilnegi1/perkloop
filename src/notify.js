// Phase 6: notification copy (pure). WhatsApp stays modular — only in-app for MVP.
export function earnCopy({ businessName, points, stamps }) {
  const bits = [];
  if (points) bits.push(`${points} pts`);
  if (stamps) bits.push(`${stamps} stamp${stamps === 1 ? '' : 's'}`);
  return { title: `Reward earned at ${businessName}`, body: bits.length ? `You earned ${bits.join(' + ')}.` : 'Visit recorded.' };
}

export function redeemCopy({ businessName, title }) {
  return { title: `Reward redeemed at ${businessName}`, body: `${title} — show confirmation if asked.` };
}
