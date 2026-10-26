import Foundation
import Testing

@testable import VisionNativeCore

@Suite struct LocalTableMemoTests {
    @Test func theRowsAreBuiltOnceUntilTheSourceTheContextOrTheQueryChange() {
        let memo = LocalTableMemo<[Int], Int, Int>()
        let query = LocalTableQuery()
        let source = [3, 1, 2]
        var made = 0
        func rows(_ source: [Int], _ context: Int, _ query: LocalTableQuery) -> [Int] {
            memo.rows(source: source, context: context, query: query) {
                made += 1
                return source.sorted()
            }
        }
        #expect(rows(source, 0, query) == [1, 2, 3])
        #expect(rows(source, 0, query) == [1, 2, 3])
        #expect(rows([3, 1, 2], 0, query) == [1, 2, 3])
        #expect(made == 1)
        #expect(rows([5, 4], 0, query) == [4, 5])
        #expect(made == 2)
        #expect(rows([5, 4], 1, query) == [4, 5])
        #expect(made == 3)
        var searched = query
        searched.search = "x"
        #expect(rows([5, 4], 1, searched) == [4, 5])
        #expect(memo.builds == 4)
    }
}
