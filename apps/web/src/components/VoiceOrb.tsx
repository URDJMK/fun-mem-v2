import { forwardRef, useEffect, useLayoutEffect, useRef } from 'react';
import { gsap } from 'gsap';
import { MorphSVGPlugin } from 'gsap/MorphSVGPlugin';
import type { LiveStatus } from '../lib/live';
import { GLOW_CENTRED, VOICE_SHAPES } from '../lib/mark';

gsap.registerPlugin(MorphSVGPlugin);

const reduceMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * The interview's control: the logo's glow, alone and at scale, as a button. While it records it
 * is lit Rose (an ember grows from its middle, as on the landing page), and it moves with the
 * voice: it changes shape only while someone is talking, faster the louder they are, and holds
 * still in a silence. Pressing it pauses: it goes back to the glow's own shape and goes out, Ink;
 * pressing again lights it.
 *
 * How loud comes from the microphone when there is one; otherwise (a call's other side, the
 * simulation) from whether words are being heard.
 */
export const VoiceOrb = forwardRef<
  HTMLButtonElement,
  {
    status: LiveStatus;
    /** the microphone, for how loud the room is */
    stream: MediaStream | null;
    /** words are being heard just now: the stand-in for loudness without a microphone */
    talking: boolean;
    disabled?: boolean;
    onToggle: () => void;
  }
>(function VoiceOrb({ status, stream, talking, disabled = false, onToggle }, ref) {
  const svg = useRef<SVGSVGElement>(null);
  const level = useRef(0);
  const talkingRef = useRef(talking);
  talkingRef.current = talking;
  const lit = status === 'live' || status === 'reconnecting';

  // the ember starts unseen, inside an unlit glow
  useLayoutEffect(() => {
    if (svg.current)
      gsap.set(svg.current.querySelector('.orb-ember'), { scale: 0, transformOrigin: '50% 50%' });
  }, []);

  // lit while it records; out, in the glow's own shape, while paused, starting or finishing
  useLayoutEffect(() => {
    const el = svg.current;
    if (!el) return;
    const q = gsap.utils.selector(el);
    const now = reduceMotion();
    gsap.to(q('.orb-ember'), {
      scale: lit ? 1.03 : 0,
      transformOrigin: '50% 50%',
      duration: now ? 0 : lit ? 0.9 : 0.5,
      delay: now || !lit ? 0 : 0.2,
      ease: 'power2.inOut',
      overwrite: 'auto',
    });
    if (!lit)
      gsap.to(q('.orb-glow, .orb-ember'), {
        morphSVG: GLOW_CENTRED,
        duration: now ? 0 : 0.6,
        overwrite: 'auto',
      });
  }, [lit]);

  // how loud: the microphone's level, smoothed; or words being heard
  useEffect(() => {
    if (!stream) return;
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    let raf = 0;
    const read = () => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += ((v - 128) / 128) ** 2;
      const rms = Math.sqrt(sum / buf.length);
      level.current = Math.min(1, rms * 5);
      raf = requestAnimationFrame(read);
    };
    read();
    return () => {
      cancelAnimationFrame(raf);
      void ctx.close();
    };
  }, [stream]);

  // the voice moves it: a loop through the pebbles whose speed is how loud it is (still at 0)
  useEffect(() => {
    const el = svg.current;
    if (!el || reduceMotion() || !lit) return;
    const q = gsap.utils.selector(el);
    const loop = gsap.timeline({ repeat: -1, defaults: { duration: 0.5, ease: 'sine.inOut' } });
    for (const shape of [...VOICE_SHAPES.slice(1), VOICE_SHAPES[0]!])
      loop.to(q('.orb-glow, .orb-ember'), { morphSVG: shape });
    loop.timeScale(0);
    let smooth = 0;
    // a voice's pebbles are larger than the logo's glow: drawn a little smaller, eased in, so it
    // keeps the glow's size as it starts to move
    let size = 1;
    const tick = () => {
      const heard = stream ? level.current : talkingRef.current ? 0.55 : 0;
      smooth += (heard - smooth) * 0.12;
      size += (0.68 - size) * 0.06;
      loop.timeScale(smooth < 0.04 ? 0 : 0.3 + smooth * 2.4);
      gsap.set(q('.orb-pulse'), { scale: size + smooth * 0.1, transformOrigin: '50% 50%' });
    };
    gsap.ticker.add(tick);
    return () => {
      gsap.ticker.remove(tick);
      loop.kill();
      gsap.set(q('.orb-pulse'), { scale: 1 });
    };
  }, [lit, stream]);

  const label =
    status === 'paused'
      ? 'Resume the interview'
      : status === 'connecting'
        ? 'Starting the interview'
        : 'Pause the interview';

  return (
    <button
      ref={ref}
      type="button"
      className="voice-orb"
      data-status={status}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onToggle}
    >
      <svg ref={svg} viewBox="48 48 160 160" aria-hidden="true">
        <g className="orb-pulse">
          <path className="orb-glow" d={GLOW_CENTRED} />
          <path className="orb-ember" d={GLOW_CENTRED} />
        </g>
      </svg>
    </button>
  );
});
