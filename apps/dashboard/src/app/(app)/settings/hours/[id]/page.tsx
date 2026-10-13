'use client';
import { useParams } from 'next/navigation';
import { ScheduleEditor } from '@/components/settings/hours/schedule-editor';

export default function ScheduleEditorPage() {
  const { id } = useParams<{ id: string }>();
  return <ScheduleEditor key={id} id={id} />;
}
