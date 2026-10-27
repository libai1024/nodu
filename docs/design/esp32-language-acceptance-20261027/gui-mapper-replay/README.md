# Independent Go mapper replay

This fixture captures the exact GUI Enter and paste events. The added Go test applies both changes to the patched official mapper and asserts original-source and generated-C++ text agree for JsonDocument, serializeJson and loop after each step. To rerun, place the test in `sourcemapper/` of the supplied modified source, set `NODU_GUI_FIXTURES` to this archived fixture directory, and run `go test -mod=vendor ./sourcemapper -run TestGuiEnterPasteTailSymbols -v`.

The events.json `update` field records the earlier client classifier outcome (Enter incorrectly reopened); `raw` is the exact valid UTF-16 delta. The current helper classifies both as incremental, covered by the repository adapter fixture test. This pure mapper check complements, but does not replace, the real middleware + ALS run in ../middleware/.
