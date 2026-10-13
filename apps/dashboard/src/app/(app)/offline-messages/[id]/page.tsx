'use client';
import { useParams } from 'next/navigation';
import { OfflineDetailView } from '@/components/offline/offline-detail';

export default function OfflineMessagePage() {
  const { id } = useParams<{ id: string }>();
  return <OfflineDetailView key={id} id={id} />;
}
