import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ScanPage } from "../types";

type PageCardProps = {
  page: ScanPage;
  position: number;
  onRotate: (id: string, delta: 90 | -90) => void;
  onDelete: (id: string) => void;
  onPreview: (id: string) => void;
};

function PageCard({ page, position, onRotate, onDelete, onPreview }: PageCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: page.id,
  });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`group relative rounded-lg border bg-white shadow-sm transition-shadow ${
        isDragging ? "z-10 border-sky-400 shadow-lg" : "border-stone-200 hover:shadow-md"
      }`}
    >
      {/* The thumbnail itself is the drag handle, so reordering feels direct. */}
      <div
        {...attributes}
        {...listeners}
        className="cursor-grab touch-none p-2 active:cursor-grabbing"
        aria-label={`Pagina ${position}, sleep om de volgorde te wijzigen`}
      >
        <div className="flex aspect-[1/1.414] items-center justify-center overflow-hidden rounded bg-stone-50">
          <img
            src={page.url}
            alt={`Pagina ${position}`}
            draggable={false}
            className="max-h-full max-w-full object-contain transition-transform"
            style={{
              // CSS rotation doesn't change the layout box, so a quarter-turn
              // would overflow the frame. Scale by the frame's aspect ratio to
              // bring the rotated page back inside it.
              transform: `rotate(${page.rotation}deg) scale(${
                page.rotation === 90 || page.rotation === 270 ? 1 / 1.414 : 1
              })`,
            }}
          />
        </div>
      </div>

      <div className="flex items-center justify-between gap-1 border-t border-stone-100 px-2 py-1.5">
        <span className="text-xs font-medium tabular-nums text-stone-500">{position}</span>
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <button
            type="button"
            onClick={() => onRotate(page.id, -90)}
            title="Naar links draaien"
            className="rounded p-1 text-stone-500 hover:bg-stone-100 hover:text-stone-900"
          >
            <svg viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M8 5H5v3M5 5.5A6.5 6.5 0 1 1 5 14" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => onRotate(page.id, 90)}
            title="Naar rechts draaien"
            className="rounded p-1 text-stone-500 hover:bg-stone-100 hover:text-stone-900"
          >
            <svg viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M12 5h3v3M15 5.5A6.5 6.5 0 1 0 15 14" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => onPreview(page.id)}
            title="Volledig formaat bekijken"
            className="rounded p-1 text-stone-500 hover:bg-stone-100 hover:text-stone-900"
          >
            <svg viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6">
              <circle cx="9" cy="9" r="5" />
              <path d="m13 13 4 4" strokeLinecap="round" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => onDelete(page.id)}
            title="Pagina verwijderen"
            className="rounded p-1 text-stone-500 hover:bg-red-50 hover:text-red-600"
          >
            <svg viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M4 6h12M8 6V4h4v2m-6 0 .7 9.1a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L14 6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>
    </li>
  );
}

type PageGridProps = {
  pages: ScanPage[];
  onReorder: (pages: ScanPage[]) => void;
  onRotate: (id: string, delta: 90 | -90) => void;
  onDelete: (id: string) => void;
  onPreview: (id: string) => void;
};

export function PageGrid({ pages, onReorder, onRotate, onDelete, onPreview }: PageGridProps) {
  const sensors = useSensors(
    // A small activation distance keeps the per-page buttons clickable.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = pages.findIndex((p) => p.id === active.id);
    const to = pages.findIndex((p) => p.id === over.id);
    if (from === -1 || to === -1) return;
    onReorder(arrayMove(pages, from, to));
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={pages.map((p) => p.id)} strategy={rectSortingStrategy}>
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
          {pages.map((page, i) => (
            <PageCard
              key={page.id}
              page={page}
              position={i + 1}
              onRotate={onRotate}
              onDelete={onDelete}
              onPreview={onPreview}
            />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}
