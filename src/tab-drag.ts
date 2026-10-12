export type TabSlot = { left: number; width: number };

const right = (slot: TabSlot) => slot.left + slot.width;

export function clampTabOffset(
  slots: TabSlot[],
  index: number,
  offset: number,
): number {
  const slot = slots[index];
  const min = slots[0].left - slot.left;
  const max = right(slots[slots.length - 1]) - right(slot);
  return Math.min(max, Math.max(min, offset));
}

export function tabDropIndex(
  slots: TabSlot[],
  index: number,
  offset: number,
): number {
  // A neighbor gives way once the dragged tab's leading edge covers its center.
  const left = slots[index].left + offset;
  const center = (slot: TabSlot) => slot.left + slot.width / 2;
  let target = index;
  for (let i = index + 1; i < slots.length; i++)
    if (center(slots[i]) < left + slots[index].width) target = i;
  for (let i = index - 1; i >= 0; i--) if (center(slots[i]) > left) target = i;
  return target;
}

export function tabDropOffset(
  slots: TabSlot[],
  index: number,
  target: number,
): number {
  if (target > index) return right(slots[target]) - right(slots[index]);
  return slots[target].left - slots[index].left;
}

export function tabShift(
  slots: TabSlot[],
  index: number,
  target: number,
  tab: number,
): number {
  if (tab === index) return 0;
  const neighbor = slots[index + 1] ?? slots[index - 1];
  const gap = neighbor
    ? neighbor.left > slots[index].left
      ? neighbor.left - right(slots[index])
      : slots[index].left - right(neighbor)
    : 0;
  const step = slots[index].width + gap;
  if (tab > index && tab <= target) return -step;
  if (tab < index && tab >= target) return step;
  return 0;
}

export function moveItem<T>(items: T[], from: number, to: number): T[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}
