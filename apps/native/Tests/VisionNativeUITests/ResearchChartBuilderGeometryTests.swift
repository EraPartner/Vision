import Foundation
import Testing

@testable import VisionNativeUI

@Suite("Chart Builder drawing geometry")
struct ResearchChartBuilderGeometryTests {
    @Test func logarithmicRequestFallsBackToLinearWhenAnyAxisValueIsNonpositive() {
        let domain = ResearchChartBuilderAxisGeometry(values: [-1, 10], requestsLog: true)
        #expect(!domain.logarithmic)
        #expect(domain.fraction(-1) != nil)
        #expect(domain.fraction(0) != nil)
        let positive = ResearchChartBuilderAxisGeometry(values: [1, 100], requestsLog: true)
        #expect(positive.logarithmic)
        #expect(positive.fraction(0) == nil)
        #expect(abs((positive.fraction(10) ?? 0) - 0.5) < 0.01)
    }
    @Test func axesUseIndependentDomainsAndConstantOrEmptyDataRemainFinite() {
        let left = ResearchChartBuilderAxisGeometry(values: [1, 2])
        let right = ResearchChartBuilderAxisGeometry(values: [1_000, 2_000])
        #expect(abs((left.fraction(1) ?? 0) - (right.fraction(1_000) ?? 1)) < 0.000001)
        #expect(left.upper < right.lower)
        let constant = ResearchChartBuilderAxisGeometry(values: [42, 42])
        #expect(constant.fraction(42) == 0.5)
        let empty = ResearchChartBuilderAxisGeometry(values: [.nan, .infinity])
        #expect(empty.lower.isFinite && empty.upper.isFinite)
    }
    @Test func rsiDrawingBoundsStayZeroToOneHundredRegardlessOfObservedPoints() {
        let domain = ResearchChartBuilderAxisGeometry(values: [49, 51], fixed: 0...100)
        #expect(domain.fraction(30) == 0.3)
        #expect(domain.fraction(70) == 0.7)
        #expect(domain.tick(0) == 0)
        #expect(domain.tick(1) == 100)
    }
    @Test func monotoneCurveControlsRemainWithinSegmentAndZeroSlopeAtTurningPoint() {
        let points = [CGPoint(x: 0, y: 0), CGPoint(x: 50, y: 100), CGPoint(x: 100, y: 80)]
        let curves = ResearchChartBuilderCurveGeometry.segments(points)
        #expect(curves.count == 2)
        #expect(curves[0].end == points[1])
        #expect(curves[0].secondControl.y == 100)
        #expect(curves[1].firstControl.y == 100)
        #expect(curves[0].firstControl.x > 0 && curves[0].firstControl.x < 50)
        #expect(curves[1].secondControl.x > 50 && curves[1].secondControl.x < 100)
        #expect(ResearchChartBuilderCurveGeometry.segments(Array(points.prefix(2))).isEmpty)
    }
}
