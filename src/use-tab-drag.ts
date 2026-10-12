import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";
import {
  clampTabOffset,
  moveItem,
  tabDropIndex,
  tabDropOffset,
  tabShift,
  type TabSlot,
} from "@/tab-drag";

const DRAG_THRESHOLD = 4;
const SLIDE_MS = 150;
const slide = `transform ${SLIDE_MS}ms ease`;

type Drag = {
  index: number;
  offset: number;
  target: number;
  slots: TabSlot[];
  dropping: boolean;
};

// Chrome-style tab dragging: the grabbed tab follows the pointer along the
// strip, its neighbors slide aside, and on release it settles into its slot.
export function useTabDrag(
  ids: string[],
  onSelect: (id: string) => void,
  onReorder: (ids: string[]) => void,
) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const pending = useRef<{
    pointerId: number;
    x: number;
    index: number;
    slots: TabSlot[];
    dragging: boolean;
  } | null>(null);
  const dropTimer = useRef<number>(undefined);
  useEffect(() => () => window.clearTimeout(dropTimer.current), []);

  const onPointerDown = (event: PointerEvent<HTMLElement>, index: number) => {
    if (event.button !== 0 || event.pointerType === "touch" || drag) return;
    if ((event.target as Element).closest(".tab-close")) return;
    onSelect(ids[index]);
    const tabs = event.currentTarget.parentElement!.querySelectorAll(
      ":scope > [data-tab-id]",
    );
    pending.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      index,
      slots: [...tabs].map((tab) => {
        const rect = tab.getBoundingClientRect();
        return { left: rect.left, width: rect.width };
      }),
      dragging: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const start = pending.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const delta = event.clientX - start.x;
    if (!start.dragging && Math.abs(delta) < DRAG_THRESHOLD) return;
    start.dragging = true;
    const offset = clampTabOffset(start.slots, start.index, delta);
    setDrag({
      index: start.index,
      offset,
      target: tabDropIndex(start.slots, start.index, offset),
      slots: start.slots,
      dropping: false,
    });
  };

  const onPointerUp = (event: PointerEvent<HTMLElement>) => {
    const start = pending.current;
    if (!start || start.pointerId !== event.pointerId) return;
    pending.current = null;
    if (!start.dragging || !drag) return;
    const { index, target, slots } = drag;
    setDrag({
      ...drag,
      offset: tabDropOffset(slots, index, target),
      dropping: true,
    });
    dropTimer.current = window.setTimeout(() => {
      setDrag(null);
      if (target !== index) onReorder(moveItem(ids, index, target));
    }, SLIDE_MS);
  };

  const onPointerCancel = () => {
    if (!pending.current) return;
    pending.current = null;
    setDrag(null);
  };

  const tabStyle = (index: number): CSSProperties | undefined => {
    if (!drag) return;
    if (index === drag.index)
      return {
        transform: `translateX(${drag.offset}px)`,
        transition: drag.dropping ? slide : "none",
        zIndex: 2,
      };
    const shift = tabShift(drag.slots, drag.index, drag.target, index);
    return {
      transform: shift ? `translateX(${shift}px)` : undefined,
      transition: slide,
    };
  };

  return {
    dragging: drag !== null,
    tabProps: (index: number) => ({
      "data-tab-id": ids[index],
      onPointerDown: (event: PointerEvent<HTMLElement>) =>
        onPointerDown(event, index),
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      style: tabStyle(index),
    }),
  };
}
