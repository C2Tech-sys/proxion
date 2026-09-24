export interface SparklineProps {
  values: number[];
  max?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
  className?: string | undefined;
  colorVar?: string | undefined;
}

/** A minimal inline SVG sparkline. No chart library -- uPlot arrives in a later ticket. */
export function Sparkline({
  values,
  max,
  width = 120,
  height = 28,
  className,
  colorVar = '--accent-teal',
}: SparklineProps) {
  if (values.length === 0) {
    return <svg width={width} height={height} className={className} aria-hidden="true" />;
  }
  const effectiveMax = max ?? Math.max(...values, 1);
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const points = values
    .map((v, i) => {
      const x = i * step;
      const y = height - (Math.max(0, Math.min(v, effectiveMax)) / effectiveMax) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const last = values[values.length - 1] ?? 0;
  const lastY = height - (Math.max(0, Math.min(last, effectiveMax)) / effectiveMax) * height;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      role="img"
      aria-label={`Trend, latest value ${last.toFixed(2)} of ${effectiveMax.toFixed(2)}`}
    >
      <polyline
        points={points}
        fill="none"
        stroke={`var(${colorVar})`}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={width - 1} cy={lastY} r={1.75} fill={`var(${colorVar})`} />
    </svg>
  );
}
