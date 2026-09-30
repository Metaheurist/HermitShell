"""Unit tests for money.py: salary currencies, conversion at the day's rates and the cached exchange rates."""

import json
import sys
from pathlib import Path

import pytest

PACKAGE = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(PACKAGE), str(PACKAGE.parents[1] / "common")]

import job_settings  # noqa: E402
import money  # noqa: E402
from job_extras import below_min_salary, parse_salary  # noqa: E402

RATES = {"EUR": 1.0, "GBP": 0.85718, "USD": 1.1355, "CAD": 1.6101, "AUD": 1.6211, "NZD": 2.0076}
NOW = 1_790_000_000.0


@pytest.mark.parametrize("value, code", [("GBP", "GBP"), ("gbp", "GBP"), ("£", "GBP"), ("€", "EUR"), ("$", "USD"),
                                         ("C$", "CAD"), ("NZ$", "NZD"), ("", ""), ("¥", ""), ("XYZ", ""), (None, "")])
def test_currency_code_takes_codes_and_symbols(value, code):
    assert money.currency_code(value) == code


@pytest.mark.parametrize("found, own, country, code", [
    ("£", "USD", "us", "GBP"), ("C$", "GBP", "gb", "CAD"),
    ("$", "CAD", "gb", "CAD"), ("$", "GBP", "au", "AUD"), ("$", "GBP", "gb", "USD"),
    ("", "USD", "ie", "EUR"), ("", "GBP", "", "GBP"), ("", "", "", ""),
])
def test_advert_code_works_out_a_bare_dollar_and_a_missing_symbol(found, own, country, code):
    assert money.advert_code(found, own, country) == code


def test_a_salary_in_another_currency_is_converted_and_keeps_the_advertised_figures():
    shown = money.shown_salary(parse_salary("€65,000 - €75,000"), "GBP", RATES, "gb")
    assert (shown["low"], shown["high"], shown["currency"], shown["code"]) == (55700, 64300, "£", "GBP")
    assert (shown["year_low"], shown["year_high"]) == (55700, 64300)
    assert shown["original"] == {"low": 65000, "high": 75000, "period": "year", "currency": "€"}


def test_day_and_hourly_rates_convert_at_their_own_precision():
    day = money.shown_salary(parse_salary("£350 - £400 per day"), "USD", RATES)
    assert (day["low"], day["high"], day["period"], day["year_low"]) == (464, 530, "day", 102000)
    hour = money.shown_salary(parse_salary("€30 per hour"), "GBP", RATES)
    assert hour["low"] == 25.72 and hour["period"] == "hour"


def test_a_dollar_read_as_canadian_says_so_in_the_original():
    shown = money.shown_salary(parse_salary("$90k"), "GBP", RATES, "ca")
    assert shown["original"]["currency"] == "C$" and shown["low"] == 47900


@pytest.mark.parametrize("text, own, rates", [("£45,000", "GBP", RATES), ("£45,000", "", RATES),
                                              ("€45,000", "GBP", {})])
def test_salaries_stay_as_advertised_without_a_currency_or_a_rate(text, own, rates):
    shown = money.shown_salary(parse_salary(text), own, rates, "gb")
    assert shown["low"] == 45000 and "original" not in shown and shown["code"] == money.currency_code(text[0])


def test_the_minimum_applies_after_conversion_and_unconvertible_salaries_are_kept():
    euros = parse_salary("€40,000")
    assert below_min_salary(money.shown_salary(euros, "GBP", RATES), 40000, "GBP")
    assert not below_min_salary(money.shown_salary(euros, "GBP", {}), 40000, "GBP")
    assert not below_min_salary(money.shown_salary(parse_salary("€50,000"), "GBP", RATES), 40000, "GBP")
    assert below_min_salary(parse_salary("£30,000"), 40000, "GBP") and below_min_salary(parse_salary("£30,000"), 40000, "£")


def test_each_currency_has_an_icon_that_exists():
    import job_weekly

    for code in money.CURRENCIES:
        assert (job_weekly.ICON_DIR / f"{money.icon(code)}.png").is_file()
    assert money.icon("") == money.PLAIN_ICON == "icon-salary"


# --------------------------------------------------------------------------- the profile's setting

@pytest.mark.parametrize("stored, shown", [("£", "GBP"), ("EUR", "EUR"), ("", ""), ("Rs", "")])
def test_the_dashboard_form_opens_on_a_currency_code(stored, shown):
    assert job_settings.form_values({"JOB_SALARY_CURRENCY": stored}.get)["currency"] == shown
    assert job_settings.clean_form({"currency": stored})["currency"] == shown


# --------------------------------------------------------------------------- exchange rates

class Reply:
    def __init__(self, data, size=None):
        self.data, self.content = data, b"x" * (size or 100)

    def raise_for_status(self):
        pass

    def json(self):
        return self.data


def fake_get(monkeypatch, data, calls):
    def get(url, **kw):
        calls.append((url, kw))
        return Reply(data)
    monkeypatch.setattr(money.requests, "get", get)


def test_rates_are_fetched_once_a_day_and_cached(tmp_path, monkeypatch):
    calls = []
    fake_get(monkeypatch, {"base": "EUR", "rates": {k: v for k, v in RATES.items() if k != "EUR"}}, calls)
    assert money.rates(tmp_path, now=NOW) == RATES
    assert money.rates(tmp_path, now=NOW + 3600) == RATES and len(calls) == 1
    assert json.loads((tmp_path / money.FX_FILE).read_text())["at"] == NOW
    money.rates(tmp_path, now=NOW + money.FX_MAX_AGE + 1)
    assert len(calls) == 2 and calls[0][0] == money.FX_URL


def test_old_rates_are_used_when_a_refresh_fails_and_retried_an_hour_later(tmp_path, monkeypatch):
    (tmp_path / money.FX_FILE).write_text(json.dumps({"at": NOW - 2 * money.FX_MAX_AGE, "rates": RATES}))
    calls = []
    fake_get(monkeypatch, {"error": "down"}, calls)
    assert money.rates(tmp_path, now=NOW) == RATES
    assert money.rates(tmp_path, now=NOW + 60) == RATES and len(calls) == 1
    money.rates(tmp_path, now=NOW + money.FX_RETRY + 1)
    assert len(calls) == 2
    assert money.rates(tmp_path, now=NOW + money.FX_STALE) == {}


def test_conversion_can_be_turned_off(tmp_path, monkeypatch):
    calls = []
    fake_get(monkeypatch, {"base": "EUR", "rates": RATES}, calls)
    for url in ("", "off", "OFF", None):
        assert money.rates(tmp_path, url, now=NOW) == {}
    assert not calls and not (tmp_path / money.FX_FILE).exists()
