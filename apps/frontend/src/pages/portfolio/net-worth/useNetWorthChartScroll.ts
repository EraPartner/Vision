import { useCallback, useEffect, useRef, useState } from "react";
import {
  NetWorthSnapshot,
  NetWorthSeries,
  DOMAIN_SCROLL_THRESHOLD_PX,
  DOMAIN_SCROLL_IDLE_MS,
  computeNiceYDomain,
  computeYDomain,
  computeSeriesDomainForRange,
} from "./netWorthChartUtils";

interface UseNetWorthChartScrollOptions {
  chartWidth: number;
  displaySnapshots: NetWorthSnapshot[];
  selectedSeries: NetWorthSeries;
  zoomStep: number;
}

interface UseNetWorthChartScrollResult {
  chartScrollRef: React.RefObject<HTMLDivElement | null>;
  yDomain: [number, number] | undefined;
  isAtLatest: boolean;
  scrollToLatest: () => void;
  captureZoomAnchor: () => void;
}

export function useNetWorthChartScroll({
  chartWidth,
  displaySnapshots,
  selectedSeries,
  zoomStep,
}: UseNetWorthChartScrollOptions): UseNetWorthChartScrollResult {
  const chartScrollRef = useRef<HTMLDivElement | null>(null);
  const [yDomain, setYDomain] = useState<[number, number] | undefined>(undefined);
  const [isAtLatest, setIsAtLatest] = useState(true);
  const scrollRafRef = useRef<number | null>(null);
  const scrollIdleTimerRef = useRef<number | null>(null);
  const rangeRef = useRef<{ startIndex: number; endIndex: number } | null>(null);
  const lastDomainScrollLeftRef = useRef<number>(-1);
  const pendingZoomScrollRatioRef = useRef<number | null>(null);

  const scrollToLatest = useCallback(() => {
    const scrollEl = chartScrollRef.current;
    if (!scrollEl) return;
    scrollEl.scrollTo({
      left: Math.max(0, scrollEl.scrollWidth - scrollEl.clientWidth),
      behavior: "smooth",
    });
  }, []);

  const captureZoomAnchor = useCallback(() => {
    const scrollEl = chartScrollRef.current;
    if (!scrollEl) return;
    const maxScrollLeft = Math.max(0, scrollEl.scrollWidth - scrollEl.clientWidth);
    if (maxScrollLeft <= 0) {
      pendingZoomScrollRatioRef.current = 1;
      return;
    }
    const isLatestView = scrollEl.scrollLeft >= maxScrollLeft - 8;
    pendingZoomScrollRatioRef.current = isLatestView
      ? 1
      : Math.min(1, Math.max(0, scrollEl.scrollLeft / maxScrollLeft));
  }, []);

  useEffect(() => {
    if (displaySnapshots.length === 0) {
      setYDomain(undefined);
      setIsAtLatest(true);
      rangeRef.current = null;
      lastDomainScrollLeftRef.current = -1;
      return;
    }

    const scrollEl = chartScrollRef.current;
    if (!scrollEl) {
      setYDomain(computeNiceYDomain(computeYDomain(displaySnapshots, [selectedSeries])));
      setIsAtLatest(true);
      return;
    }

    const updateVisibleDomain = (force = false) => {
      const totalPoints = displaySnapshots.length;
      if (totalPoints === 0) return;

      const maxScrollLeft = Math.max(0, scrollEl.scrollWidth - scrollEl.clientWidth);
      const nextIsAtLatest = maxScrollLeft <= 2 || scrollEl.scrollLeft >= maxScrollLeft - 8;
      setIsAtLatest((prev) => (prev === nextIsAtLatest ? prev : nextIsAtLatest));

      if (
        !force
        && lastDomainScrollLeftRef.current >= 0
        && Math.abs(scrollEl.scrollLeft - lastDomainScrollLeftRef.current) < DOMAIN_SCROLL_THRESHOLD_PX
      ) {
        return;
      }
      lastDomainScrollLeftRef.current = scrollEl.scrollLeft;

      const maxIndex = totalPoints - 1;
      const safeScrollWidth = Math.max(scrollEl.scrollWidth, 1);
      const startRatio = scrollEl.scrollLeft / safeScrollWidth;
      const endRatio = (scrollEl.scrollLeft + scrollEl.clientWidth) / safeScrollWidth;

      const startIndex = Math.max(0, Math.floor(startRatio * maxIndex) - 1);
      const endIndex = Math.min(maxIndex, Math.ceil(endRatio * maxIndex) + 1);
      const previousRange = rangeRef.current;
      const rangeUnchanged = previousRange
        && previousRange.startIndex === startIndex
        && previousRange.endIndex === endIndex;

      if (force || !rangeUnchanged) {
        rangeRef.current = { startIndex, endIndex };
        const hasVisibleRange = endIndex >= startIndex;
        const nextDomain = hasVisibleRange
          ? computeNiceYDomain(computeSeriesDomainForRange(displaySnapshots, selectedSeries, startIndex, endIndex))
          : computeNiceYDomain(computeYDomain(displaySnapshots, [selectedSeries]));
        const safeDomain: [number, number] = Number.isFinite(nextDomain[0])
          && Number.isFinite(nextDomain[1])
          && nextDomain[1] > nextDomain[0]
          ? nextDomain
          : computeNiceYDomain(computeYDomain(displaySnapshots, [selectedSeries]));
        setYDomain((prev) => {
          if (prev && prev[0] === safeDomain[0] && prev[1] === safeDomain[1]) return prev;
          return safeDomain;
        });
      }
    };

    const scheduleUpdate = () => {
      if (scrollRafRef.current !== null) return;
      scrollRafRef.current = window.requestAnimationFrame(() => {
        scrollRafRef.current = null;
        updateVisibleDomain();
      });
    };

    const onScrollWithIdle = () => {
      scheduleUpdate();
      if (scrollIdleTimerRef.current !== null) {
        window.clearTimeout(scrollIdleTimerRef.current);
      }
      scrollIdleTimerRef.current = window.setTimeout(() => {
        scrollIdleTimerRef.current = null;
        updateVisibleDomain(true);
      }, DOMAIN_SCROLL_IDLE_MS);
    };

    const onResize = () => scheduleUpdate();

    scrollEl.addEventListener('scroll', onScrollWithIdle, { passive: true });
    window.addEventListener('resize', onResize);

    const rafId = window.requestAnimationFrame(() => {
      const nextMaxScrollLeft = Math.max(0, scrollEl.scrollWidth - scrollEl.clientWidth);
      const pendingRatio = pendingZoomScrollRatioRef.current;

      if (pendingRatio !== null) {
        scrollEl.scrollLeft = pendingRatio >= 1 ? nextMaxScrollLeft : pendingRatio * nextMaxScrollLeft;
        pendingZoomScrollRatioRef.current = null;
      } else if (rangeRef.current === null) {
        scrollEl.scrollLeft = nextMaxScrollLeft;
      }

      lastDomainScrollLeftRef.current = scrollEl.scrollLeft;
      updateVisibleDomain(true);
    });

    return () => {
      window.cancelAnimationFrame(rafId);
      if (scrollRafRef.current !== null) {
        window.cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
      if (scrollIdleTimerRef.current !== null) {
        window.clearTimeout(scrollIdleTimerRef.current);
        scrollIdleTimerRef.current = null;
      }
      scrollEl.removeEventListener('scroll', onScrollWithIdle);
      window.removeEventListener('resize', onResize);
    };
  }, [chartWidth, displaySnapshots, selectedSeries, zoomStep]);

  return { chartScrollRef, yDomain, isAtLatest, scrollToLatest, captureZoomAnchor };
}
