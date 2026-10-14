'use client';
import { useEffect, useRef } from 'react';

/**
 * Specks of light drifting up through the hero, in the widget colour. Drawn on one canvas at the stage's own
 * 1440x810 size, so the scene scale handles every window. Stops when the tab is hidden or the hero leaves view.
 */
export function Particles({ color, count = 70 }: { color: string; count?: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const tint = useRef(color);
  tint.current = color;

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const W = 1440;
    const H = 810;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);

    // Most specks rise from the floor under the bubble; a few wander across the dark side for depth.
    const seed = () => {
      const near = Math.random() < 0.72;
      return {
        x: near ? 620 + Math.random() * 640 : Math.random() * W,
        y: H * (0.45 + Math.random() * 0.6),
        r: 0.6 + Math.random() * 1.8,
        vy: 0.12 + Math.random() * 0.42,
        vx: (Math.random() - 0.5) * 0.18,
        life: Math.random(),
        speed: 0.0018 + Math.random() * 0.004,
      };
    };
    const dots = Array.from({ length: count }, seed);

    let raf = 0;
    let visible = true;
    const draw = () => {
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = tint.current;
      for (const d of dots) {
        d.y -= d.vy;
        d.x += d.vx + Math.sin((d.life + d.y) * 0.01) * 0.12;
        d.life += d.speed;
        if (d.life >= 1 || d.y < -10) Object.assign(d, seed(), { life: 0 });
        // Fade in, hold, fade out over each speck's life.
        const a = Math.sin(Math.PI * d.life) * 0.85;
        ctx.globalAlpha = a;
        ctx.shadowColor = tint.current;
        ctx.shadowBlur = d.r * 6;
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        ctx.fill();
      }
      raf = visible ? requestAnimationFrame(draw) : 0;
    };

    const io = new IntersectionObserver(([e]) => {
      visible = !!e?.isIntersecting && document.visibilityState === 'visible';
      if (visible && !raf) raf = requestAnimationFrame(draw);
    });
    io.observe(canvas);
    const onVis = () => {
      visible = document.visibilityState === 'visible';
      if (visible && !raf) raf = requestAnimationFrame(draw);
    };
    document.addEventListener('visibilitychange', onVis);
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [count]);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        mixBlendMode: 'screen',
        pointerEvents: 'none',
      }}
    />
  );
}
