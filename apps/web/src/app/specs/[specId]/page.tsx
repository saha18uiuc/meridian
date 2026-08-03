'use client';

import type { SpecJson } from '@meridian/core/schemas';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { SpecViewer } from '@/features/spec/SpecViewer';

interface SpecPayload {
  specId: string;
  specVersion: number;
  specJson: SpecJson;
  specHash: string;
  sourceCanvasHash: string;
  sourceRevisionNo: number;
  unresolvedCommentIds: string[];
}

export default function SpecPage() {
  const params = useParams<{ specId: string }>();
  const [spec, setSpec] = useState<SpecPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const response = await fetch(`/api/specs/${params.specId}`);
      if (!response.ok) {
        setError(`HTTP ${response.status}`);
        return;
      }
      setSpec((await response.json()) as SpecPayload);
    })();
  }, [params.specId]);

  if (error !== null) return <p className="banner error">{error}</p>;
  if (spec === null) return <p className="muted">Loading specification…</p>;

  return (
    <SpecViewer
      specId={spec.specId}
      specJson={spec.specJson}
      specHash={spec.specHash}
      sourceCanvasHash={spec.sourceCanvasHash}
      sourceRevisionNo={spec.sourceRevisionNo}
      unresolvedCommentIds={spec.unresolvedCommentIds}
    />
  );
}
