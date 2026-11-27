import Testing

@testable import VisionNativeUI

/// Audit finding 27: Return in a searchable picker chooses the row the user reached, not the first.
@Suite("Searchable picker active row")
struct PickerActiveRowTests {
    private let ids = ["create", "none", "7", "9"]

    @Test func downDownReachesTheThirdRowAndStopsAtTheEnds() {
        var active = PickerActiveRow.kept(nil, in: ids)
        #expect(active == "create")
        active = PickerActiveRow.moved(active, by: 1, in: ids)
        active = PickerActiveRow.moved(active, by: 1, in: ids)
        #expect(active == "7")
        #expect(PickerActiveRow.moved("9", by: 1, in: ids) == "9")
        #expect(PickerActiveRow.moved("create", by: -1, in: ids) == "create")
    }

    @Test func listChangesKeepAListedRowElseActivateTheFirst() {
        #expect(PickerActiveRow.kept("7", in: ["none", "7"]) == "7")
        #expect(PickerActiveRow.kept("create", in: ["none", "7"]) == "none")
        #expect(PickerActiveRow.kept("7", in: []) == nil)
        #expect(PickerActiveRow.moved(nil, by: 1, in: []) == nil)
    }
}
