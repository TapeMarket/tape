import { useId, useRef } from "react";
import { WORDMARK_PATH } from "./Wordmark";

export function LandingArrow() {
  return <svg className="lp-arrow" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 12h15m-6-6 6 6-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

/** Tape, made physical. Native SVG stays sharp and light at every size. */
export function TapeSculpture() {
  const id = useId().replace(/:/g, "");
  const ref = useRef<HTMLDivElement>(null);
  return <div className="lp-tape-art" aria-hidden="true" ref={ref}
    onPointerMove={(e) => {
      if (e.pointerType !== "mouse" || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const box = e.currentTarget.getBoundingClientRect();
      ref.current?.style.setProperty("--tilt-x", `${(e.clientY - box.top - box.height / 2) / box.height * -9}deg`);
      ref.current?.style.setProperty("--tilt-y", `${(e.clientX - box.left - box.width / 2) / box.width * 12}deg`);
    }}
    onPointerLeave={() => { ref.current?.style.setProperty("--tilt-x", "0deg"); ref.current?.style.setProperty("--tilt-y", "0deg"); }}>
    <svg viewBox="0 0 620 540" className="lp-tape-sculpture" fill="none">
      <defs>
        <linearGradient id={`${id}-body`} x1="200" y1="150" x2="540" y2="360" gradientUnits="userSpaceOnUse"><stop stopColor="#4164ff" /><stop offset=".44" stopColor="#1640ff" /><stop offset="1" stopColor="#0928b2" /></linearGradient>
        <linearGradient id={`${id}-face`} x1="40" y1="260" x2="460" y2="400" gradientUnits="userSpaceOnUse"><stop stopColor="#1640ff" /><stop offset=".55" stopColor="#2952ff" /><stop offset="1" stopColor="#1034d8" /></linearGradient>
        <linearGradient id={`${id}-core`} x1="360" y1="110" x2="360" y2="220" gradientUnits="userSpaceOnUse"><stop stopColor="#d5dcf0" /><stop offset="1" stopColor="#fff" /></linearGradient>
        <filter id={`${id}-shadow`} x="-50%" y="-150%" width="200%" height="400%"><feGaussianBlur stdDeviation="15" /></filter>
      </defs>
      <ellipse cx="323" cy="473" rx="198" ry="17" fill="#0a1638" opacity=".12" filter={`url(#${id}-shadow)`} />
      <g className="lp-tape-object" transform="rotate(-16 320 250)">
        <path d="M198 153V308C198 363 270 408 359 408S520 363 520 308V153C520 208 448 252 359 252S198 208 198 153Z" fill={`url(#${id}-body)`} />
        <path d="M198 307C198 362 270 406 359 406S520 362 520 307" stroke="#071f98" strokeOpacity=".4" strokeWidth="2" />
        <ellipse cx="359" cy="153" rx="161" ry="99" fill="#355aff" />
        <ellipse cx="359" cy="153" rx="157" ry="95" stroke="#8ca1ff" strokeOpacity=".65" strokeWidth="2" />
        {[146, 137, 128, 119, 110].map((rx) => <ellipse key={rx} cx="359" cy="153" rx={rx} ry={rx * .615} stroke="#142fb0" strokeOpacity=".12" />)}
        <ellipse cx="359" cy="153" rx="94" ry="57" fill={`url(#${id}-core)`} />
        <ellipse cx="359" cy="159" rx="82" ry="47" fill="#111f49" />
        <path d="M277 159C277 133 314 112 359 112S441 133 441 159V185C420 201 392 208 359 208S298 201 277 185Z" fill="#0a1638" />
        <path d="M198 251C198 294 153 310 48 305L48 429C175 436 228 409 253 364C279 319 285 264 285 224Z" fill="#0b2fc9" />
        <path d="M48 305C163 311 212 277 228 241C247 199 257 169 278 151L278 275C257 294 247 323 228 365C212 402 163 435 48 429Z" fill={`url(#${id}-face)`} />
        <path d="M48 305C163 311 212 277 228 241C247 199 257 169 278 151" stroke="#6a86ff" strokeWidth="2" />
        <path d={WORDMARK_PATH} transform="translate(64 328) rotate(-10) scale(.29 .42)" fill="#fff" fillRule="evenodd" />
        <path d="M48 429C163 435 212 402 228 365" stroke="#061f9d" strokeOpacity=".45" strokeWidth="2" />
      </g>
    </svg>
  </div>;
}
