import type { GameState, Position, Rule } from "./game";
const weekly: [
    string,
    string,
    number
][] = [
    ["rec", "PPR", 1], ["rush_yd", "Rushing Yards", 0.1], ["rush_td", "Rushing TD", 6],
    ["rush_att", "Rush Attempts", 0], ["rec_yd", "Receiving Yards", 0.1],
    ["rec_td", "Receiving TD", 6], ["bonus_rec_rb", "Reception Bonus RB", 0],
    ["bonus_rec_wr", "Reception Bonus WR", 0], ["idp_sack", "Sack", 2],
    ["idp_tkl_solo", "Solo Tackle", 1], ["idp_tkl", "Tackle", 1],
    ["idp_tkl_ast", "Assisted Tackle", 0.5], ["idp_pass_def", "Pass Defended", -5],
];
const permanent: [
    string,
    string,
    number
][] = [
    ["pass_2pt", "Passing 2PT", 2], ["pass_cmp_40p", "40+ completion", 0],
    ["pass_td_40p", "40+ passing TD", 0], ["pass_td_50p", "50+ passing TD", 0],
    ["rush_2pt", "Rushing 2PT", 2], ["rush_40p", "40+ rush yard", 0],
    ["rush_td_40p", "40+ rush TD", 0], ["pts_allow_0", "Points allowed 0", 10],
    ["yds_allow_0_100", "Less than 100 yards allowed", 5],
    ["blk_kick", "Blocked kick", 2], ["st_fum_rec", "Special teams fumble recovery", 2],
];
export const defaultRules: Rule[] = [
    ...weekly.map(([id, name, baseline]) => ({ id, name, baseline, duration: "Weekly" as const })),
    ...permanent.map(([id, name, baseline]) => ({ id, name, baseline, duration: "Permanent" as const })),
];
const managerNames = ["Brandon Flis", "Sal Maniaci", "Enzo Maniaci", "Matthew Razz", "Matthew Vedua", "Brendan Wiley", "Adam Trombley", "Jacob Commyn", "Ryan Anderson", "Michael Reiterman"];
const demoPlayers: Record<Position, [
    string,
    string
][]> = {
    QB: [["Josh Allen", "BUF"], ["Lamar Jackson", "BAL"], ["Drake Maye", "NE"], ["Joe Burrow", "CIN"], ["Jayden Daniels", "WAS"], ["Patrick Mahomes", "KC"], ["Jaxson Dart", "NYG"], ["Justin Herbert", "LAC"], ["Caleb Williams", "CHI"], ["Trevor Lawrence", "JAX"], ["Jalen Hurts", "PHI"], ["Brock Purdy", "SF"]],
    RB: [["Bijan Robinson", "ATL"], ["Jahmyr Gibbs", "DET"], ["Saquon Barkley", "PHI"], ["Christian McCaffrey", "SF"], ["Jonathan Taylor", "IND"], ["De'Von Achane", "MIA"], ["Derrick Henry", "BAL"], ["James Cook", "BUF"], ["Breece Hall", "NYJ"], ["Ashton Jeanty", "LV"], ["Josh Jacobs", "GB"], ["Kyren Williams", "LAR"]],
    WR: [["Ja'Marr Chase", "CIN"], ["Puka Nacua", "LAR"], ["Jaxon Smith-Njigba", "SEA"], ["Amon-Ra St. Brown", "DET"], ["CeeDee Lamb", "DAL"], ["Justin Jefferson", "MIN"], ["Drake London", "ATL"], ["Nico Collins", "HOU"], ["George Pickens", "DAL"], ["Malik Nabers", "NYG"], ["A.J. Brown", "PHI"], ["Brian Thomas Jr.", "JAX"]],
    TE: [["Brock Bowers", "LV"], ["Trey McBride", "ARI"], ["George Kittle", "SF"], ["Sam LaPorta", "DET"], ["Tyler Warren", "IND"], ["Colston Loveland", "CHI"], ["Travis Kelce", "KC"], ["T.J. Hockenson", "MIN"], ["Tucker Kraft", "GB"], ["Mark Andrews", "BAL"], ["Dalton Kincaid", "BUF"], ["Dallas Goedert", "PHI"]],
};
export function initialState(): GameState {
    return {
        season: 2026, week: 1, leagueId: "", source: "Practice data - fictional rankings, not live Sleeper stats",
        managers: managerNames.map((name, i) => ({ id: `manager-${i}`, name })),
        players: Object.entries(demoPlayers).flatMap(([position, list]) => list.map(([name, team], i) => ({
            id: `demo-${position}-${i}`, name, team, position: position as Position,
            points: Math.round((342.8 - i * 16.37) * 10) / 10, injury: i === 10 ? "Questionable" : null,
        }))),
        excluded: [], locked: [], assignments: [], rules: defaultRules, changes: [],
        pending: { duration: null, ruleId: null }, lastSpin: null,
    };
}
