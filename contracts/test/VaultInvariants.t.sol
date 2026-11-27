// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {AgentVault} from "../src/vault/AgentVault.sol";
import {AgentVaultFactory} from "../src/vault/AgentVaultFactory.sol";
import {IVenueAdapter} from "../src/vault/Interfaces.sol";

// ------------------------------------------------------------------ test doubles

contract TestToken {
    string public name;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory n, uint8 d) {
        name = n;
        decimals = d;
    }

    function mint(address to, uint256 v) public {
        totalSupply += v;
        balanceOf[to] += v;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        return true;
    }

    function approve(address s, uint256 v) external returns (bool) {
        allowance[msg.sender][s] = v;
        return true;
    }

    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        allowance[f][msg.sender] -= v;
        balanceOf[f] -= v;
        balanceOf[to] += v;
        return true;
    }
}

contract TestWeth is TestToken {
    constructor() TestToken("WETH", 18) {}

    function deposit() external payable {
        mint(msg.sender, msg.value);
    }

    function withdraw(uint256 v) external {
        balanceOf[msg.sender] -= v;
        totalSupply -= v;
        (bool ok,) = msg.sender.call{value: v}("");
        require(ok, "eth");
    }
}

contract TestFeed {
    int256 public answer;
    uint256 public updatedAt;

    constructor(int256 a) {
        set(a);
    }

    function set(int256 a) public {
        answer = a;
        updatedAt = block.timestamp;
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

/// A venue that misbehaves on purpose. Mode 0 pays the oracle price less `cutBps`; mode 1
/// sends the approved tokens to a thief and pays nothing; mode 2 tries to pull more than it
/// was approved for; mode 3 pays a thief instead of the vault.
contract HostileVenue is IVenueAdapter {
    address public immutable thief;
    mapping(address => TestFeed) public feedOf;

    constructor(address thief_) {
        thief = thief_;
    }

    function setFeed(address token, TestFeed f) external {
        feedOf[token] = f;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256, address recipient, bytes calldata data)
        external
        returns (uint256 out)
    {
        (uint8 mode, uint16 cutBps) = abi.decode(data, (uint8, uint16));
        if (mode == 1) {
            TestToken(tokenIn).transferFrom(msg.sender, thief, amountIn);
            return 0;
        }
        if (mode == 2) {
            TestToken(tokenIn).transferFrom(msg.sender, address(this), amountIn + 1);
        } else {
            TestToken(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        }
        uint256 usd = (amountIn * uint256(feedOf[tokenIn].answer())) / 10 ** TestToken(tokenIn).decimals();
        out = (usd * 10 ** TestToken(tokenOut).decimals()) / uint256(feedOf[tokenOut].answer());
        out = (out * (10_000 - cutBps)) / 10_000;
        TestToken(tokenOut).mint(mode == 3 ? thief : recipient, out);
    }
}

// ------------------------------------------------------------------ handler

/// Random actions against one vault. Every swap that succeeds is checked against the oracle
/// floor computed here independently; anything that should be impossible sets a flag.
contract VaultHandler is Test {
    AgentVault public immutable vault;
    HostileVenue public immutable venue;
    address public immutable owner;
    address public immutable executor;
    address public immutable stranger;
    TestToken[3] public tokens;
    TestFeed[3] public feeds;
    uint16 public immutable slipBps;

    bool public badSwapSucceeded;
    string public badReason;
    bool public strangerMovedFunds;
    /// Known limit, found by this test: a swap worth less than two base units of the output token
    /// has an oracle floor of 0, so a hostile venue could keep that dust. What the thief got
    /// that way, per token, and how many such swaps there were.
    mapping(address => uint256) public thiefDust;
    uint256 public zeroFloorSwaps;
    uint256 public swaps;
    uint256 public refused;
    uint256 public returns_;

    constructor(AgentVault v, HostileVenue h, address o, address e, address s, TestToken[3] memory t, TestFeed[3] memory f, uint16 slip) {
        vault = v;
        venue = h;
        owner = o;
        executor = e;
        stranger = s;
        tokens = t;
        feeds = f;
        slipBps = slip;
    }

    struct Before {
        uint256 floor;
        uint256 valueIn;
        uint256 vaultOut;
        uint256 thiefIn;
        uint256 thiefOut;
    }

    function swap(uint256 seed, uint256 amount, uint8 mode, uint16 cutBps) external {
        TestToken tin = tokens[seed % 3];
        TestToken tout = tokens[(seed % 3 + 1 + (seed / 3) % 2) % 3];
        uint256 have = tin.balanceOf(address(vault));
        if (have == 0) return;
        // Sizes around the $500 trade limit (some above it), most of the time; any size otherwise.
        uint256 cap = (600e8 * 10 ** tin.decimals()) / uint256(feedFor(tin).answer());
        amount = bound(amount, 1, seed % 4 == 0 || cap == 0 || cap > have ? have : cap);
        Before memory b = _before(tin, tout, amount);
        // Half the venues are honest; prices around the 2% allowance (some worse than it).
        uint8 m = seed % 2 == 0 ? 0 : uint8(bound(mode, 0, 3));
        bytes memory data = abi.encode(m, uint16(bound(cutBps, 0, 400)));
        vm.prank(executor);
        try vault.swap(address(venue), address(tin), address(tout), amount, 0, data, bytes32(0)) returns (uint256 got) {
            _after(tin, tout, m, got, b);
        } catch {
            refused++;
        }
    }

    function _before(TestToken tin, TestToken tout, uint256 amount) private view returns (Before memory b) {
        (b.floor, b.valueIn) = _floor(tin, tout, amount);
        b.vaultOut = tout.balanceOf(address(vault));
        b.thiefIn = tin.balanceOf(venue.thief());
        b.thiefOut = tout.balanceOf(venue.thief());
    }

    function _after(TestToken tin, TestToken tout, uint8 mode, uint256 got, Before memory b) private {
        swaps++;
        if (tout.balanceOf(address(vault)) - b.vaultOut != got) _bad("vault output differs from what swap returned", got, b);
        if (b.floor == 0) {
            // Dust: no floor. The floor rounds to 0 exactly when the swap is worth less than two
            // base units of the output token (the vault divides before it applies the slippage
            // allowance), so anything above that must have had a floor.
            zeroFloorSwaps++;
            if (b.valueIn * 10 ** tout.decimals() >= 2 * uint256(feedFor(tout).answer())) _bad("zero floor on a swap worth two output units or more", got, b);
            thiefDust[address(tin)] += tin.balanceOf(venue.thief()) - b.thiefIn;
            thiefDust[address(tout)] += tout.balanceOf(venue.thief()) - b.thiefOut;
        } else if (mode != 0) {
            // Above dust, only an honest venue can succeed...
            _bad(string.concat("hostile venue mode ", vm.toString(mode), " succeeded"), got, b);
        } else if (got < b.floor) {
            // ...and only within the slippage allowance.
            _bad("paid below the oracle floor", got, b);
        }
    }

    function _bad(string memory why, uint256 got, Before memory b) private {
        badSwapSucceeded = true;
        badReason = string.concat(why, " | got ", vm.toString(got), " floor ", vm.toString(b.floor), " valueIn ", vm.toString(b.valueIn));
    }

    function movePrice(uint256 i, uint256 bps, bool up) external {
        TestFeed f = feeds[i % 3];
        bps = bound(bps, 0, 3000);
        int256 a = f.answer();
        int256 next = up ? a + (a * int256(bps)) / 10_000 : a - (a * int256(bps)) / 10_000;
        if (next > 0) f.set(next);
    }

    function passTime(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 12 hours));
        // Feeds keep answering, as live feeds do (a stale feed makes swaps revert, also fine).
        for (uint256 i; i < 3; ++i) feeds[i].set(feeds[i].answer());
    }

    function strangerTriesWithdraw(uint256 i, uint256 amount) external {
        TestToken t = tokens[i % 3];
        uint256 before = t.balanceOf(address(vault));
        vm.prank(stranger);
        try vault.withdraw(address(t), bound(amount, 0, before), stranger) {
            strangerMovedFunds = true;
        } catch {}
        address[] memory all = _all();
        vm.prank(stranger);
        try vault.returnToOwner(all) {
            strangerMovedFunds = true;
        } catch {}
        vm.prank(stranger);
        try vault.swap(address(venue), address(tokens[0]), address(tokens[1]), 1, 0, abi.encode(uint8(0), uint16(0)), bytes32(0)) {
            strangerMovedFunds = true;
        } catch {}
    }

    /// Ends a run now and then (about one call in forty), as Stop does.
    function executorReturnsAll(uint256 seed) external {
        if (seed % 40 != 0) return;
        vm.prank(executor);
        vault.returnToOwner(_all());
        returns_++;
    }

    /// The owner puts money in again (a new run), so swaps keep being exercised.
    function ownerDeposits(uint256 amount) external {
        TestToken usd = tokens[0];
        amount = bound(amount, 1e6, 1_000e6);
        usd.mint(owner, amount);
        vm.prank(owner);
        usd.transfer(address(vault), amount);
    }

    function _all() private view returns (address[] memory all) {
        all = new address[](3);
        for (uint256 i; i < 3; ++i) all[i] = address(tokens[i]);
    }

    function _floor(TestToken tin, TestToken tout, uint256 amount) private view returns (uint256 floor, uint256 valueIn) {
        valueIn = (amount * uint256(feedFor(tin).answer())) / 10 ** tin.decimals();
        floor = (((valueIn * 10 ** tout.decimals()) / uint256(feedFor(tout).answer())) * (10_000 - slipBps)) / 10_000;
    }

    function feedFor(TestToken t) public view returns (TestFeed) {
        for (uint256 i; i < 3; ++i) if (tokens[i] == t) return feeds[i];
        revert("no feed");
    }
}

// ------------------------------------------------------------------ the properties

contract VaultInvariants is Test {
    AgentVault vault;
    VaultHandler handler;
    HostileVenue venue;
    address owner = makeAddr("owner");
    address executor = makeAddr("executor");
    address stranger = makeAddr("stranger");
    address thief = makeAddr("thief");
    TestToken usd;
    TestWeth weth;
    TestToken stock;
    TestFeed fu;
    TestFeed fw;
    TestFeed fs;
    uint256 constant MAX_DAILY = 2_000e8;

    function setUp() public {
        usd = new TestToken("USD", 6);
        weth = new TestWeth();
        stock = new TestToken("STOCK", 18);
        vm.deal(address(weth), 1_000_000 ether); // backs WETH the venue mints, so it can be unwrapped
        fu = new TestFeed(1e8);
        fw = new TestFeed(2_000e8);
        fs = new TestFeed(10e8);
        AgentVaultFactory factory = _factory();
        _venue();
        _vault(factory);
        handler = new VaultHandler(vault, venue, owner, executor, stranger, [usd, TestToken(address(weth)), stock], [fu, fw, fs], 200);
        targetContract(address(handler));
    }

    function _factory() private returns (AgentVaultFactory) {

        address[] memory list = new address[](3);
        list[0] = address(usd);
        list[1] = address(weth);
        list[2] = address(stock);
        AgentVaultFactory.Feed[] memory fl = new AgentVaultFactory.Feed[](3);
        fl[0] = AgentVaultFactory.Feed(address(fu), 1 days);
        fl[1] = AgentVaultFactory.Feed(address(fw), 1 days);
        fl[2] = AgentVaultFactory.Feed(address(fs), 1 days);
        return new AgentVaultFactory(address(this), address(usd), address(weth), list, fl);
    }

    function _venue() private {
        venue = new HostileVenue(thief);
        venue.setFeed(address(usd), fu);
        venue.setFeed(address(weth), fw);
        venue.setFeed(address(stock), fs);
    }

    function _vault(AgentVaultFactory factory) private {

        address[] memory tradable = new address[](2);
        tradable[0] = address(weth);
        tradable[1] = address(stock);
        address[] memory venues = new address[](1);
        venues[0] = address(venue);
        AgentVault.Policy memory p = AgentVault.Policy({maxTradeUsd: 500e8, maxDailyUsd: MAX_DAILY, maxTokenUsd: 0, maxSlippageBps: 200});

        usd.mint(owner, 1_000e6);
        vm.startPrank(owner);
        usd.approve(address(factory), 1_000e6);
        vault = factory.createVaultWith(executor, p, tradable, venues, address(usd), 1_000e6);
        vm.stopPrank();
    }

    /// Money leaves the vault only to its owner, or to the venue in exchange for at least the
    /// oracle-implied output: no executor or stranger ever holds anything, and a thief holds
    /// only dust from swaps too small to have an oracle floor (the known limit above).
    function invariant_nobodyButTheOwnerGetsFunds() public view {
        TestToken[3] memory ts = [usd, TestToken(address(weth)), stock];
        for (uint256 i; i < 3; ++i) {
            assertEq(ts[i].balanceOf(executor), 0, "executor holds tokens");
            assertEq(ts[i].balanceOf(stranger), 0, "stranger holds tokens");
            assertEq(ts[i].balanceOf(thief), handler.thiefDust(address(ts[i])), "thief holds more than dust");
        }
        assertEq(executor.balance, 0, "executor got ETH");
        assertEq(stranger.balance, 0, "stranger got ETH");
    }

    /// Every swap that went through paid at least the oracle price less the slippage allowance,
    /// through an honest venue; cheating venues always fail.
    function invariant_onlyFairSwapsSucceed() public view {
        assertFalse(handler.badSwapSucceeded(), handler.badReason());
    }

    /// The known limit, pinned down: a hostile venue keeps a swap worth less than two base units
    /// of the output token (here 6 wei of WETH, about 1e-14 USD). A later vault version should
    /// refuse a swap whose floor is 0.
    function test_knownLimit_dustSwapHasNoFloor() public {
        vm.prank(owner);
        vault.withdraw(address(usd), 1, owner); // leaves the vault's USD untouched otherwise
        TestToken(address(weth)).mint(address(vault), 6);
        vm.prank(executor);
        uint256 got = vault.swap(address(venue), address(weth), address(usd), 6, 0, abi.encode(uint8(1), uint16(0)), bytes32(0));
        assertEq(got, 0);
        assertEq(weth.balanceOf(thief), 6);
        // One unit more of value than dust and the same venue is refused.
        TestToken(address(weth)).mint(address(vault), 1e12);
        vm.prank(executor);
        vm.expectRevert();
        vault.swap(address(venue), address(weth), address(usd), 1e12, 0, abi.encode(uint8(1), uint16(0)), bytes32(0));
    }

    /// Only the owner (or, for returnToOwner, the executor) can move funds.
    function invariant_strangersCannotMoveFunds() public view {
        assertFalse(handler.strangerMovedFunds(), "a stranger moved funds");
    }

    /// After each run: how much was really exercised (swaps that went through, swaps refused,
    /// dust swaps), so a run that only ever hits reverts does not pass unnoticed.
    function afterInvariant() public view {
        console2.log("swaps ok", handler.swaps(), "refused", handler.refused());
        console2.log("dust swaps", handler.zeroFloorSwaps(), "returns", handler.returns_());
    }

    /// The day's traded volume never exceeds the owner's daily limit.
    function invariant_dailyVolumeWithinLimit() public view {
        assertLe(vault.dayVolumeUsd(), MAX_DAILY, "daily volume over the limit");
    }

    /// The vault never leaves an allowance behind for a venue.
    function invariant_noLeftoverApprovals() public view {
        TestToken[3] memory ts = [usd, TestToken(address(weth)), stock];
        for (uint256 i; i < 3; ++i) assertEq(ts[i].allowance(address(vault), address(venue)), 0, "leftover approval");
    }

    // -------------------------------------------------------------- fuzzed single properties

    function testFuzz_onlyOwnerWithdraws(address caller, uint256 amount) public {
        vm.assume(caller != owner);
        amount = bound(amount, 1, 1_000e6);
        vm.prank(caller);
        vm.expectRevert(AgentVault.NotOwner.selector);
        vault.withdraw(address(usd), amount, caller);
    }

    function testFuzz_ownerAlwaysWithdrawsEvenWhenPaused(uint256 amount) public {
        amount = bound(amount, 1, 1_000e6);
        vm.prank(owner);
        vault.setPaused(true);
        vm.prank(owner);
        vault.withdraw(address(usd), amount, owner);
        assertEq(usd.balanceOf(owner), amount);
    }

    function testFuzz_slippageCapCannotBeRaised(uint16 bps) public {
        vm.assume(bps > vault.MAX_SLIPPAGE_CAP_BPS());
        AgentVault.Policy memory p = AgentVault.Policy({maxTradeUsd: 500e8, maxDailyUsd: MAX_DAILY, maxTokenUsd: 0, maxSlippageBps: bps});
        vm.prank(owner);
        vm.expectRevert(AgentVault.BadPolicy.selector);
        vault.setPolicy(p);
    }

    function testFuzz_onlyExecutorSwaps(address caller) public {
        vm.assume(caller != executor);
        vm.prank(caller);
        vm.expectRevert(AgentVault.NotExecutor.selector);
        vault.swap(address(venue), address(usd), address(weth), 1e6, 0, abi.encode(uint8(0), uint16(0)), bytes32(0));
    }

    function testFuzz_tradeAboveLimitRefused(uint256 amount) public {
        amount = bound(amount, 500e6 + 1, 1_000e6); // over the $500 trade limit
        vm.prank(executor);
        vm.expectRevert();
        vault.swap(address(venue), address(usd), address(weth), amount, 0, abi.encode(uint8(0), uint16(0)), bytes32(0));
    }

    function test_stalePriceStopsTrading() public {
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(executor);
        vm.expectRevert();
        vault.swap(address(venue), address(usd), address(weth), 10e6, 0, abi.encode(uint8(0), uint16(0)), bytes32(0));
    }
}
