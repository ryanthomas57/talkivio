'use client';
import { useParams } from 'next/navigation';
import { TriggerEditorRoute } from '@/components/triggers/trigger-editor';

export default function TriggerEditorPage() {
  const { id } = useParams<{ id: string }>();
  return <TriggerEditorRoute key={id} id={id} />;
}
