'use client';

import type { PrimitiveType } from '@meridian/core/schemas';
import { PRIMITIVE_GUIDE } from '@meridian/core/vocabulary';
import { Handle, Position } from '@xyflow/react';

/**
 * The shell every card shares: the kind, the title, and the two connection points.
 *
 * The handles were previously bare `<Handle>` elements, which React Flow styles as a 6px dot the
 * same colour as the card border. Connecting two cards was therefore possible and undiscoverable —
 * you had to already know that the dot was draggable. They are labelled and given a visible target
 * here, because on a whiteboard the arrow between two shapes carries as much of the process as the
 * shapes do.
 *
 * The one-sentence explanation is attached as the card's tooltip so that the answer to "what is a
 * Rule?" is available on the object itself, not only in the inspector after you have selected it.
 */
export function CardFrame({
  primitiveType,
  title,
  children,
  selected,
}: {
  primitiveType: PrimitiveType;
  title: string;
  children: React.ReactNode;
  selected: boolean;
}) {
  const guide = PRIMITIVE_GUIDE[primitiveType];
  return (
    <article
      className={`card card-${primitiveType}${selected ? ' selected' : ''}`}
      aria-label={`${guide.label} card ${title}`}
      title={guide.sentence}
      data-primitive={primitiveType}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="card-handle card-handle-in"
        title="Drop an arrow here to lead into this card"
      />
      <header>
        <span className="card-kind">{guide.label}</span>
        <span className="card-title">{title}</span>
      </header>
      {children}
      <Handle
        type="source"
        position={Position.Right}
        className="card-handle card-handle-out"
        title="Drag from here to connect this card to another"
      />
    </article>
  );
}
