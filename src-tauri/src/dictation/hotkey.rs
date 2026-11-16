//! Deterministic routing policy, deliberately independent of UI/Windows calls.
//! A press owns its routing decision until release; availability/focus changes
//! must never turn a forwarded down into a swallowed up (or vice versa).

pub const VK_CONTROL: u32 = 0x11;
pub const VK_RCONTROL: u32 = 0xA3;
pub const LLKHF_EXTENDED: u32 = 0x01;
pub const LLKHF_INJECTED: u32 = 0x10;
pub const TEST_INPUT_MARKER: usize = 0x5445_3730;

const WM_KEYDOWN: u32 = 0x0100;
const WM_KEYUP: u32 = 0x0101;
const WM_SYSKEYDOWN: u32 = 0x0104;
const WM_SYSKEYUP: u32 = 0x0105;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PressState {
    #[default]
    Idle,
    Consumed,
    Forwarded,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Route {
    Consume,
    Forward,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Edge {
    Down,
    Repeat,
    Up,
    OrphanUp,
    Unknown,
    Bypass,
    Guard,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Physical,
    Injected,
    Test,
}

pub fn is_right_ctrl(vk: u32, flags: u32) -> bool {
    vk == VK_RCONTROL || (vk == VK_CONTROL && flags & LLKHF_EXTENDED != 0)
}

pub fn source(flags: u32, extra: usize, allow_test_input: bool) -> Source {
    if flags & LLKHF_INJECTED == 0 {
        Source::Physical
    } else if allow_test_input && extra == TEST_INPUT_MARKER {
        Source::Test
    } else {
        Source::Injected
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Decision {
    pub route: Route,
    pub edge: Edge,
}

impl PressState {
    pub fn transition(&mut self, msg: u32, try_toggle: impl FnOnce() -> bool) -> Decision {
        match msg {
            WM_KEYDOWN | WM_SYSKEYDOWN => {
                let edge = if *self == Self::Idle {
                    *self = if try_toggle() {
                        Self::Consumed
                    } else {
                        Self::Forwarded
                    };
                    Edge::Down
                } else {
                    Edge::Repeat
                };
                Decision {
                    route: self.route(),
                    edge,
                }
            }
            WM_KEYUP | WM_SYSKEYUP => {
                let decision = Decision {
                    route: self.route(),
                    edge: if *self == Self::Idle {
                        Edge::OrphanUp
                    } else {
                        Edge::Up
                    },
                };
                *self = Self::Idle;
                decision
            }
            _ => Decision {
                route: Route::Forward,
                edge: Edge::Unknown,
            },
        }
    }

    fn route(self) -> Route {
        if self == Self::Consumed {
            Route::Consume
        } else {
            Route::Forward
        }
    }
}

// Safe to transfer consumption ownership only between complete presses.
pub fn can_renew(physical: PressState, test: PressState) -> bool {
    physical == PressState::Idle && test == PressState::Idle
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RoutingState {
    pub physical: PressState,
    pub test: PressState,
    pub physical_press: u64,
    pub test_press: u64,
}

impl RoutingState {
    pub fn transition(
        &mut self,
        source: Source,
        msg: u32,
        try_toggle: impl FnOnce() -> bool,
    ) -> Decision {
        match source {
            Source::Physical => {
                if self.physical == PressState::Idle && is_down(msg) {
                    self.physical_press = self.physical_press.wrapping_add(1);
                }
                self.physical.transition(msg, try_toggle)
            }
            Source::Test => {
                if self.test == PressState::Idle && is_down(msg) {
                    self.test_press = self.test_press.wrapping_add(1);
                }
                self.test.transition(msg, try_toggle)
            }
            Source::Injected => Decision {
                route: Route::Forward,
                edge: Edge::Bypass,
            },
        }
    }

    pub fn can_renew(self) -> bool {
        can_renew(self.physical, self.test)
    }

    // A replacement hook shields repeats of an already-consumed press, but
    // MUST let a genuine up continue to the old hook and intervening hooks.
    pub fn guard_consumes_repeat(self, source: Source, msg: u32) -> bool {
        is_down(msg)
            && match source {
                Source::Physical => self.physical == PressState::Consumed,
                Source::Test => self.test == PressState::Consumed,
                Source::Injected => false,
            }
    }

    // Called AFTER CallNextHookEx. If the old hook was removed (or an earlier
    // hook swallowed this release), our guard has still observed a genuine up.
    // A press ID prevents a reentrant/new down from being cleared by an older up.
    pub fn recover_guard_release(&mut self, source: Source, msg: u32, before: Self) -> bool {
        if !matches!(msg, WM_KEYUP | WM_SYSKEYUP) {
            return false;
        }
        match source {
            Source::Physical
                if self.physical_press == before.physical_press
                    && before.physical != PressState::Idle
                    && self.physical == before.physical =>
            {
                self.physical = PressState::Idle;
                true
            }
            Source::Test
                if self.test_press == before.test_press
                    && before.test != PressState::Idle
                    && self.test == before.test =>
            {
                self.test = PressState::Idle;
                true
            }
            _ => false,
        }
    }
}

fn is_down(msg: u32) -> bool {
    matches!(msg, WM_KEYDOWN | WM_SYSKEYDOWN)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_key_representations_exclude_left_ctrl_and_other_keys() {
        assert!(is_right_ctrl(VK_RCONTROL, 0));
        assert!(is_right_ctrl(VK_CONTROL, LLKHF_EXTENDED));
        assert!(!is_right_ctrl(VK_CONTROL, 0));
        assert!(!is_right_ctrl(0xA2, LLKHF_EXTENDED));
        assert!(!is_right_ctrl(0x41, LLKHF_EXTENDED));
    }

    #[test]
    fn normal_system_and_mixed_pairs_toggle_once_and_share_routing() {
        for down in [WM_KEYDOWN, WM_SYSKEYDOWN] {
            for up in [WM_KEYUP, WM_SYSKEYUP] {
                let mut state = PressState::Idle;
                let mut toggles = 0;
                let first = state.transition(down, || {
                    toggles += 1;
                    true
                });
                assert_eq!(
                    first,
                    Decision {
                        route: Route::Consume,
                        edge: Edge::Down
                    }
                );
                for repeat in [WM_KEYDOWN, WM_SYSKEYDOWN].into_iter().cycle().take(100) {
                    assert_eq!(
                        state.transition(repeat, || panic!("repeat dispatched")),
                        Decision {
                            route: Route::Consume,
                            edge: Edge::Repeat
                        }
                    );
                }
                assert_eq!(
                    state.transition(up, || panic!("release dispatched")).route,
                    first.route
                );
                assert_eq!(state, PressState::Idle);
                assert_eq!(toggles, 1);
            }
        }
    }

    #[test]
    fn unavailable_or_full_worker_forwards_entire_press_even_after_recovery() {
        let mut state = PressState::Idle;
        assert_eq!(state.transition(WM_KEYDOWN, || false).route, Route::Forward);
        assert_eq!(state, PressState::Forwarded);
        assert_eq!(
            state
                .transition(WM_SYSKEYDOWN, || panic!("must not retry mid-press"))
                .route,
            Route::Forward
        );
        assert_eq!(state.transition(WM_KEYUP, || true).route, Route::Forward);
        assert_eq!(state.transition(WM_KEYDOWN, || true).route, Route::Consume);
    }

    #[test]
    fn actual_bounded_queue_backpressure_cannot_split_a_press() {
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        sender.try_send(()).unwrap();
        let mut state = PressState::Idle;
        assert_eq!(
            state
                .transition(WM_KEYDOWN, || sender.try_send(()).is_ok())
                .route,
            Route::Forward
        );
        receiver.recv().unwrap(); // worker recovers before the release
        assert_eq!(
            state
                .transition(WM_KEYUP, || sender.try_send(()).is_ok())
                .route,
            Route::Forward
        );
        assert!(matches!(
            receiver.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Empty)
        ));
        assert_eq!(
            state
                .transition(WM_SYSKEYDOWN, || sender.try_send(()).is_ok())
                .route,
            Route::Consume
        );
        receiver.recv().unwrap();
        assert_eq!(
            state.transition(WM_SYSKEYUP, || false).route,
            Route::Consume
        );
    }

    #[test]
    fn worker_failure_after_consumed_down_does_not_leak_release() {
        let mut state = PressState::Idle;
        state.transition(WM_KEYDOWN, || true);
        assert_eq!(state.transition(WM_KEYDOWN, || false).route, Route::Consume);
        assert_eq!(
            state.transition(WM_SYSKEYUP, || false).route,
            Route::Consume
        );
    }

    #[test]
    fn orphan_release_passes_and_unknown_message_preserves_press() {
        let mut state = PressState::Idle;
        assert_eq!(
            state.transition(WM_KEYUP, || false),
            Decision {
                route: Route::Forward,
                edge: Edge::OrphanUp
            }
        );
        state.transition(WM_SYSKEYDOWN, || true);
        assert_eq!(
            state.transition(0, || panic!("unknown dispatched")).edge,
            Edge::Unknown
        );
        assert_eq!(state, PressState::Consumed);
        assert_eq!(state.transition(WM_KEYUP, || true).route, Route::Consume);
    }

    #[test]
    fn startup_held_key_is_forwarded_without_toggling_until_release() {
        let mut state = PressState::Forwarded;
        assert_eq!(
            state
                .transition(WM_KEYDOWN, || panic!("startup repeat toggled"))
                .route,
            Route::Forward
        );
        assert_eq!(state.transition(WM_KEYUP, || false).route, Route::Forward);
        assert_eq!(state.transition(WM_KEYDOWN, || true).route, Route::Consume);
    }

    #[test]
    fn no_hook_reordering_during_consumed_forwarded_or_test_hold() {
        for physical in [
            PressState::Idle,
            PressState::Consumed,
            PressState::Forwarded,
        ] {
            for test in [
                PressState::Idle,
                PressState::Consumed,
                PressState::Forwarded,
            ] {
                assert_eq!(
                    can_renew(physical, test),
                    physical == PressState::Idle && test == PressState::Idle
                );
            }
        }
    }

    #[test]
    fn competing_hook_model_keeps_a_seen_down_paired_across_renewal_tick() {
        // This models chain ordering, NOT mstsc's actual implementation. If a
        // competing hook is ahead of ours, it sees even our consumed events.
        let seen_by_competitor = |ahead: bool, route: Route| ahead || route == Route::Forward;
        let mut state = RoutingState::default();
        let mut competitor_ahead = true;
        let down = state.transition(Source::Physical, WM_KEYDOWN, || true);
        assert!(seen_by_competitor(competitor_ahead, down.route));
        // Previous unconditional renewal would move us ahead mid-press.
        assert!(!seen_by_competitor(false, Route::Consume));
        if state.can_renew() {
            competitor_ahead = false;
        }
        let up = state.transition(Source::Physical, WM_KEYUP, || false);
        assert!(seen_by_competitor(competitor_ahead, up.route));
        assert!(state.can_renew());
    }

    #[test]
    fn lost_release_is_not_guessed_from_elapsed_time_or_focus() {
        let mut state = RoutingState::default();
        state.transition(Source::Physical, WM_KEYDOWN, || true);
        // State must remain owned until a genuine release; a future raw-input
        // recovery mechanism needs independent evidence, not a timeout reset.
        for _ in 0..100 {
            assert!(!state.can_renew());
        }
        assert_eq!(
            state.transition(Source::Physical, WM_KEYUP, || false).route,
            Route::Consume
        );
        assert!(state.can_renew());
    }

    #[test]
    fn guard_recovers_a_removed_owner_only_after_a_real_release() {
        let mut state = RoutingState::default();
        state.transition(Source::Physical, WM_KEYDOWN, || true);
        let before = state;
        assert!(state.guard_consumes_repeat(Source::Physical, WM_SYSKEYDOWN));
        assert!(!state.recover_guard_release(Source::Physical, WM_KEYDOWN, before));
        assert!(!state.recover_guard_release(Source::Injected, WM_KEYUP, before));
        assert_eq!(state.physical, PressState::Consumed);
        assert!(state.recover_guard_release(Source::Physical, WM_KEYUP, before));
        assert!(state.can_renew());
        assert_eq!(
            state.transition(Source::Physical, WM_KEYDOWN, || true).edge,
            Edge::Down
        );
    }

    #[test]
    fn guard_does_not_clear_a_reentrant_new_press() {
        let mut state = RoutingState::default();
        state.transition(Source::Physical, WM_KEYDOWN, || true);
        let before = state;
        // CallNextHookEx may reenter the installing thread. The owner receives
        // the up and a new down before the outer guard callback returns.
        state.transition(Source::Physical, WM_KEYUP, || false);
        state.transition(Source::Physical, WM_KEYDOWN, || true);
        assert!(!state.recover_guard_release(Source::Physical, WM_KEYUP, before));
        assert_eq!(state.physical, PressState::Consumed);
    }

    #[test]
    fn guard_preserves_forwarded_pairs_and_separate_test_ownership() {
        let mut state = RoutingState::default();
        state.transition(Source::Physical, WM_KEYDOWN, || false);
        state.transition(Source::Test, WM_KEYDOWN, || true);
        let before = state;
        assert!(!state.guard_consumes_repeat(Source::Physical, WM_KEYDOWN));
        assert!(state.guard_consumes_repeat(Source::Test, WM_KEYDOWN));
        assert!(state.recover_guard_release(Source::Test, WM_KEYUP, before));
        assert_eq!(state.physical, PressState::Forwarded);
        assert!(!state.can_renew());
        assert!(state.recover_guard_release(Source::Physical, WM_SYSKEYUP, before));
        assert!(state.can_renew());
    }

    #[test]
    fn guard_never_steals_release_from_intervening_competing_hook() {
        let mut state = RoutingState::default();
        let down = state.transition(Source::Physical, WM_KEYDOWN, || true);
        assert_eq!(down.route, Route::Consume);
        // Competing hook was ahead of owner and saw down. New guard is ahead of
        // BOTH; it passes up to the competitor, then the old owner consumes it.
        assert!(!state.guard_consumes_repeat(Source::Physical, WM_KEYUP));
        let before = state;
        let up = state.transition(Source::Physical, WM_KEYUP, || false);
        assert_eq!(up.route, Route::Consume);
        assert!(!state.recover_guard_release(Source::Physical, WM_KEYUP, before));
        assert!(state.can_renew());
    }

    #[test]
    fn untrusted_injected_events_never_impersonate_physical_or_test_input() {
        assert_eq!(source(0, TEST_INPUT_MARKER, true), Source::Physical);
        for extra in [0, TEST_INPUT_MARKER] {
            assert_eq!(source(LLKHF_INJECTED, extra, false), Source::Injected);
        }
        assert_eq!(source(LLKHF_INJECTED, 0, true), Source::Injected);
        assert_eq!(
            source(LLKHF_INJECTED, TEST_INPUT_MARKER, true),
            Source::Test
        );
    }

    #[test]
    fn injected_release_cannot_clear_physical_hold_or_toggle_dictation() {
        let mut state = RoutingState::default();
        state.transition(Source::Physical, WM_KEYDOWN, || true);
        for msg in [WM_KEYDOWN, WM_SYSKEYDOWN, WM_KEYUP, WM_SYSKEYUP] {
            assert_eq!(
                state
                    .transition(Source::Injected, msg, || panic!("injected input toggled"))
                    .route,
                Route::Forward
            );
            assert_eq!(state.physical, PressState::Consumed);
            assert!(!state.can_renew());
        }
        assert_eq!(
            state
                .transition(Source::Physical, WM_SYSKEYDOWN, || panic!("repeat toggled"))
                .edge,
            Edge::Repeat
        );
        assert_eq!(
            state.transition(Source::Physical, WM_KEYUP, || false).route,
            Route::Consume
        );
        assert!(state.can_renew());
    }

    #[test]
    fn tagged_test_and_physical_keys_have_separate_press_ownership() {
        let mut state = RoutingState::default();
        state.transition(Source::Physical, WM_KEYDOWN, || true);
        state.transition(Source::Test, WM_KEYDOWN, || false);
        assert_eq!(
            state.transition(Source::Test, WM_KEYUP, || true).route,
            Route::Forward
        );
        assert_eq!(state.physical, PressState::Consumed);
        assert!(!state.can_renew());
        assert_eq!(
            state.transition(Source::Physical, WM_KEYUP, || false).route,
            Route::Consume
        );
        assert!(state.can_renew());
    }

    #[test]
    fn fifty_thousand_presses_keep_down_up_paired_under_dispatch_failures() {
        let mut state = PressState::Idle;
        let mut toggles = 0;
        for i in 0..50_000 {
            let available = i % 7 != 0;
            let down = state.transition(
                if i % 2 == 0 {
                    WM_KEYDOWN
                } else {
                    WM_SYSKEYDOWN
                },
                || {
                    if available {
                        toggles += 1;
                    }
                    available
                },
            );
            for _ in 0..i % 5 {
                assert_eq!(
                    state
                        .transition(WM_SYSKEYDOWN, || panic!("repeat dispatched"))
                        .route,
                    down.route
                );
            }
            assert_eq!(state.transition(WM_KEYUP, || !available).route, down.route);
            assert_eq!(state, PressState::Idle);
        }
        assert_eq!(toggles, (0..50_000).filter(|i| i % 7 != 0).count());
    }
}
