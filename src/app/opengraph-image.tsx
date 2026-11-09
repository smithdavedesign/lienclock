import { ImageResponse } from 'next/og';
import { PRO_PRICE_LABEL } from '@/lib/billing';
import { SUPPORTED_STATES } from '@/lib/rules';
import { SHARE_IMAGE } from './seo';

// The og:image and twitter:image for every page. Prerendered once at build time (never drawn per
// request): on the Worker it's served from static assets.
export const alt = SHARE_IMAGE.alt;
export const size = { width: SHARE_IMAGE.width, height: SHARE_IMAGE.height };
export const contentType = SHARE_IMAGE.type;
export const dynamic = 'force-static';

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '72px 80px',
          background: '#1f3a5f',
          color: '#ffffff',
        }}
      >
        <div style={{ display: 'flex', fontSize: 40, fontWeight: 700, color: '#f2c14e' }}>LienClock</div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', fontSize: 68, fontWeight: 700, lineHeight: 1.1 }}>Which lien clocks just started?</div>
          <div style={{ display: 'flex', fontSize: 34, marginTop: 28, color: '#d9e2ef' }}>
            {`Preliminary-notice and lien deadlines for subcontractors in ${SUPPORTED_STATES.length} states, with the statute behind each date.`}
          </div>
        </div>
        <div style={{ display: 'flex', fontSize: 34, color: '#f2c14e' }}>{`Alerts before they lapse · ${PRO_PRICE_LABEL}, no per-notice fees`}</div>
      </div>
    ),
    size,
  );
}
