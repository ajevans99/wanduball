import type { Position } from "../game";
import { HttpError } from "./http";

// Sleeper publishes sparse event counters, including exclusive yardage tiers,
// overlapping long-play counters, and position-specific bonuses. Use those
// counters verbatim, never reconstruct them from totals or longest plays.
const scoringCounters = new Set(`
  pass_yd pass_td pass_int pass_int_td pass_2pt pass_att pass_cmp pass_inc pass_sack
  pass_fd pass_cmp_40p pass_td_40p pass_td_50p
  rush_yd rush_td rush_2pt rush_att rush_fd rush_40p rush_td_40p rush_td_50p
  rec rec_yd rec_td rec_2pt rec_fd rec_0_4 rec_5_9 rec_10_19 rec_20_29 rec_30_39
  rec_40p rec_td_40p rec_td_50p
  bonus_pass_yd_300 bonus_pass_yd_400 bonus_pass_cmp_25 bonus_rush_att_20
  bonus_rush_yd_100 bonus_rush_yd_200 bonus_rec_yd_100 bonus_rec_yd_200
  bonus_rush_rec_yd_100 bonus_rush_rec_yd_200 bonus_rush_td_qb
  bonus_rec_rb bonus_rec_wr bonus_rec_te bonus_fd_qb bonus_fd_rb bonus_fd_wr bonus_fd_te
  fum fum_lost fum_rec fum_rec_td fum_ret_yd kr_yd pr_yd blk_kick_ret_yd fg_ret_yd
  st_td st_ff st_fum_rec st_tkl_solo
  idp_tkl idp_tkl_solo idp_tkl_ast idp_tkl_loss idp_sack idp_sack_yd idp_qb_hit
  idp_int idp_int_ret_yd idp_ff idp_fum_rec idp_fum_ret_yd idp_pass_def
  idp_pass_def_3p idp_blk_kick idp_safe idp_def_td bonus_tkl_10p bonus_sack_2p
  sack sack_yd qb_hit int int_ret_yd ff tkl tkl_solo tkl_ast tkl_loss
  safe blk_kick def_td def_2pt def_pass_def def_3_and_out def_4_and_stop
  def_forced_punts def_kr_yd def_pr_yd def_st_td def_st_ff def_st_fum_rec def_st_tkl_solo
  bonus_def_fum_td_50p bonus_def_int_td_50p
  pts_allow pts_allow_0 pts_allow_1_6 pts_allow_7_13 pts_allow_14_20 pts_allow_21_27
  pts_allow_28_34 pts_allow_35p yds_allow yds_allow_0_100 yds_allow_100_199
  yds_allow_200_299 yds_allow_300_349 yds_allow_350_399 yds_allow_400_449
  yds_allow_450_499 yds_allow_500_549 yds_allow_550p
  fgm fgm_yds fgm_yds_over_30 fgm_0_19 fgm_20_29 fgm_30_39 fgm_40_49
  fgm_50p fgm_50_59 fgm_60p fgmiss fgmiss_0_19 fgmiss_20_29 fgmiss_30_39
  fgmiss_40_49 fgmiss_50p fgmiss_50_59 fgmiss_60p xpm xpmiss
`.trim().split(/\s+/));

export function validateScoring(settings: Record<string, number>) {
  const unsupported = Object.keys(settings).filter(key => settings[key] !== 0 && !scoringCounters.has(key));
  if (unsupported.length) {
    throw new HttpError(422, `Unsupported nonzero Sleeper scoring settings: ${unsupported.sort().join(", ")}. No approximate league rankings were imported.`);
  }
}

export function leaguePoints(
  stats: Record<string, number | null>,
  settings: Record<string, number>,
  position: Position,
) {
  let points = 0;
  for (const [key, weight] of Object.entries(settings)) {
    if (!weight) continue;
    const bonusPosition = /^bonus_(?:rec|fd|rush_td)_(qb|rb|wr|te)$/.exec(key)?.[1];
    if (bonusPosition && bonusPosition.toUpperCase() !== position) continue;
    // A missing counter is zero in Sleeper's sparse actual-stat payload.
    // An explicit null is not evidence of zero and must not silently rank.
    if (stats[key] === null) throw new HttpError(422, `Sleeper returned an unavailable scoring counter (${key}). Retry after statistics are updated.`);
    points += (stats[key] ?? 0) * weight;
  }
  return points;
}
