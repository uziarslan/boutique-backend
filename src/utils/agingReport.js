/**
 * bucketize(dueDate, today)
 *
 * Assigns an invoice to an AP aging bucket based on days past due.
 *
 * @param {Date|string|null} dueDate  - The invoice due date.
 * @param {Date}             today    - Reference date (typically midnight today).
 * @returns {'current'|'1-30'|'31-60'|'61-90'|'90plus'}
 */
const bucketize = (dueDate, today) => {
  if (!dueDate) return 'current';

  const due        = new Date(dueDate);
  due.setHours(0, 0, 0, 0);
  const ref        = new Date(today);
  ref.setHours(0, 0, 0, 0);

  const MS_PER_DAY = 86_400_000;
  const daysPast   = Math.floor((ref - due) / MS_PER_DAY);

  if (daysPast <= 0)  return 'current';
  if (daysPast <= 30) return '1-30';
  if (daysPast <= 60) return '31-60';
  if (daysPast <= 90) return '61-90';
  return '90plus';
};

export default bucketize;
