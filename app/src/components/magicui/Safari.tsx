import { useId, type HTMLAttributes, type ReactNode } from 'react';
import './magicui.css';

const SAFARI_WIDTH = 1203;
const SAFARI_HEIGHT = 753;
const SCREEN_X = 1;
const SCREEN_Y = 52;
const SCREEN_WIDTH = 1200;
const SCREEN_HEIGHT = 700;

export type SafariMode = 'default' | 'simple';
/** Magic UI Safari with a children aperture for Polygraph's live iframe. */
export interface SafariProps extends HTMLAttributes<HTMLDivElement> {
  url?: string;
  imageSrc?: string;
  videoSrc?: string;
  mode?: SafariMode;
  children?: ReactNode;
}

export function Safari({ imageSrc, videoSrc, url, mode = 'default', children, className, style, ...props }: SafariProps) {
  const maskId = useId().replaceAll(':', '');
  const hasVideo = Boolean(videoSrc);
  const hasContent = hasVideo || Boolean(imageSrc) || Boolean(children);
  return (
    <div className={['pg-magic-safari', className].filter(Boolean).join(' ')} style={{ aspectRatio: `${SAFARI_WIDTH}/${SAFARI_HEIGHT}`, ...style }} {...props}>
      {hasVideo ? <div className="pg-magic-safari__screen"><video src={videoSrc} autoPlay loop muted playsInline preload="metadata" /></div> : null}
      {!hasVideo && imageSrc ? <div className="pg-magic-safari__screen"><img src={imageSrc} alt="" /></div> : null}
      {!hasVideo && !imageSrc && children ? <div className="pg-magic-safari__screen pg-magic-safari__screen--children">{children}</div> : null}
      <svg viewBox={`0 0 ${SAFARI_WIDTH} ${SAFARI_HEIGHT}`} fill="none" xmlns="http://www.w3.org/2000/svg" className="pg-magic-safari__chrome" aria-hidden="true">
        <defs>
          <mask id={maskId} maskUnits="userSpaceOnUse"><rect x="0" y="0" width={SAFARI_WIDTH} height={SAFARI_HEIGHT} fill="white" /><path d="M1 52H1201V741C1201 747.075 1196.08 752 1190 752H12C5.92486 752 1 747.075 1 741V52Z" fill="black" /></mask>
        </defs>
        <g mask={hasContent ? `url(#${maskId})` : undefined}>
          <path d="M0 52H1202V741C1202 747.627 1196.63 753 1190 753H12C5.37258 753 0 747.627 0 741V52Z" className="pg-magic-safari__shell" />
          <path fillRule="evenodd" clipRule="evenodd" d="M0 12C0 5.37258 5.37258 0 12 0H1190C1196.63 0 1202 5.37258 1202 12V52H0L0 12Z" className="pg-magic-safari__shell" />
          <path fillRule="evenodd" clipRule="evenodd" d="M1.06738 12C1.06738 5.92487 5.99225 1 12.0674 1H1189.93C1196.01 1 1200.93 5.92487 1200.93 12V51H1.06738V12Z" className="pg-magic-safari__top" />
          <circle cx="27" cy="25" r="6" className="pg-magic-safari__control" /><circle cx="47" cy="25" r="6" className="pg-magic-safari__control" /><circle cx="67" cy="25" r="6" className="pg-magic-safari__control" />
          <path d="M286 17C286 13.6863 288.686 11 292 11H946C949.314 11 952 13.6863 952 17V35C952 38.3137 949.314 41 946 41H292C288.686 41 286 38.3137 286 35V17Z" className="pg-magic-safari__address" />
          <text x="580" y="30" className="pg-magic-safari__url" textAnchor="middle">{url}</text>
          {mode === 'default' ? <><path d="M143.914 32.5938C144.094 32.7656 144.312 32.8594 144.562 32.8594C145.086 32.8594 145.492 32.4531 145.492 31.9375C145.492 31.6797 145.391 31.4453 145.211 31.2656L139.742 25.9219L145.211 20.5938C145.391 20.4141 145.492 20.1719 145.492 19.9219C145.492 19.4062 145.086 19 144.562 19C144.312 19 144.094 19.0938 143.922 19.2656L137.844 25.2031C137.625 25.4062 137.516 25.6562 137.516 25.9297C137.516 26.2031 137.625 26.4375 137.836 26.6484L143.914 32.5938Z" className="pg-magic-safari__icon" /><path d="M168.422 32.8594C168.68 32.8594 168.891 32.7656 169.07 32.5938L175.148 26.6562C175.359 26.4375 175.469 26.2109 175.469 25.9297C175.469 25.6562 175.367 25.4141 175.148 25.2109L169.07 19.2656C168.891 19.0938 168.68 19 168.422 19C167.898 19 167.492 19.4062 167.492 19.9219C167.492 20.1719 167.602 20.4141 167.773 20.5938L173.25 25.9375L167.773 31.2656C167.594 31.4531 167.492 31.6797 167.492 31.9375C167.492 32.4531 167.898 32.8594 168.422 32.8594Z" className="pg-magic-safari__icon" /></> : null}
        </g>
      </svg>
    </div>
  );
}

export const safariScreenRect = { x: SCREEN_X, y: SCREEN_Y, width: SCREEN_WIDTH, height: SCREEN_HEIGHT, canvasWidth: SAFARI_WIDTH, canvasHeight: SAFARI_HEIGHT };
