# Detector disposition

One detector run was performed on the new brand page and changed toolbar brand component. The original findings are preserved in `detector.json`; the detector was not rerun.

- Functional microtext at 8–10px: raised every such CSS font-size to at least 11px, including mobile direction captions, download labels, palette values, and the illustrative toolbar. The supporting capability descriptions and sample note now use 12px.
- Four cramped-padding reports on capability rows: these rows already used 17px block padding. They now use explicit `padding: 17px 0` with identical rendering; no flush text was visible in the captures.
- Token advisories: the brand page adds brand colors and related surface shades, a 15px reading size, logo-showcase heading sizes, and app-icon illustration radii. These were deliberate additions within the initial graphite/mint world. The user subsequently selected blue; the current brand expands the same graphite/warm-white layout with blue accent variants. The actual app keeps its existing sizing and shell. Documentation will record the additions after review.

The confirmed captures following these changes replace the initial captures at the same paths. The initial detector output is evidence of what was checked, not a claim that its original text-size findings remain unfixed.
