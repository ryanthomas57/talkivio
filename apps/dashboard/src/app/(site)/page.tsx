import type { Metadata } from 'next';
import { HomePage } from '@/components/site/home';

export const metadata: Metadata = {
  title: { absolute: 'Talkivio | Live chat with real-time visitor tracking' },
  description:
    'See who is on your website right now, with location, IP and network, and start the conversation in one click. Docked chat windows, file sharing, triggers and routing. 14-day free trial.',
  openGraph: {
    title: 'Talkivio | Live chat with real-time visitor tracking',
    description: 'See every visitor in real time and start the conversation in one click.',
    images: [{ url: '/site/hero-1440.webp', width: 1440, height: 810 }],
    type: 'website',
  },
};

export default function Index() {
  return <HomePage />;
}
