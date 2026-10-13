'use client';
import { useParams } from 'next/navigation';
import { DepartmentDetail } from '@/components/settings/departments/department-detail';

export default function DepartmentDetailPage() {
  const { id } = useParams<{ id: string }>();
  return <DepartmentDetail key={id} id={id} />;
}
