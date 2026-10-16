import { BadRequestException, HttpException, Injectable } from '@nestjs/common';
import {
  PlaceDetailsDto,
  PlacesAutocompleteDto,
} from './dto/google-places.dto';
import { GooglePlacesService } from './google-places.service';

type RequestWindow = { count: number; until: number };
type RegistrationSession = {
  ip: string;
  until: number;
  requests: number;
  consumed: boolean;
  placeIds: Set<string>;
};

const MINUTE = 60_000;
const SESSION_TTL = 10 * MINUTE;
const MAX_ENTRIES = 10_000;
const RATE_LIMIT_MESSAGE =
  'Too many address searches. Please try again shortly or enter the address manually.';
const SESSION_MESSAGE =
  'Search for the address again or enter the address manually.';

@Injectable()
export class RegistrationPlacesService {
  private readonly minuteWindows = new Map<string, RequestWindow>();
  private readonly hourWindows = new Map<string, RequestWindow>();
  private readonly sessions = new Map<string, RegistrationSession>();
  private nextCleanup = 0;

  constructor(private readonly places: GooglePlacesService) {}

  private cleanup(now: number) {
    if (
      now < this.nextCleanup &&
      this.minuteWindows.size < MAX_ENTRIES &&
      this.hourWindows.size < MAX_ENTRIES &&
      this.sessions.size < MAX_ENTRIES
    ) {
      return;
    }
    for (const entries of [
      this.minuteWindows,
      this.hourWindows,
      this.sessions,
    ]) {
      for (const [key, entry] of entries) {
        if (entry.until <= now) entries.delete(key);
      }
    }
    this.nextCleanup = now + MINUTE;
  }

  private admitWindow(
    entries: Map<string, RequestWindow>,
    ip: string,
    now: number,
    duration: number,
    maximum: number,
  ) {
    let entry = entries.get(ip);
    if (!entry || entry.until <= now) {
      if (!entry && entries.size >= MAX_ENTRIES) {
        throw new HttpException(RATE_LIMIT_MESSAGE, 429);
      }
      entry = { count: 0, until: now + duration };
      entries.set(ip, entry);
    }
    if (++entry.count > maximum) {
      throw new HttpException(RATE_LIMIT_MESSAGE, 429);
    }
  }

  private admitRequest(ip: string, now: number) {
    this.cleanup(now);
    // Token rotation does not reset the IP budget. Both endpoints count.
    this.admitWindow(this.minuteWindows, ip, now, MINUTE, 60);
    this.admitWindow(this.hourWindows, ip, now, 60 * MINUTE, 240);
  }

  async autocomplete(ip: string, input: PlacesAutocompleteDto) {
    const now = Date.now();
    this.admitRequest(ip, now);
    let session = this.sessions.get(input.sessionToken);
    if (session && session.until <= now) {
      this.sessions.delete(input.sessionToken);
      session = undefined;
    }
    if (!session) {
      if (this.sessions.size >= MAX_ENTRIES) {
        throw new HttpException(RATE_LIMIT_MESSAGE, 429);
      }
      session = {
        ip,
        until: now + SESSION_TTL,
        requests: 0,
        consumed: false,
        placeIds: new Set(),
      };
      this.sessions.set(input.sessionToken, session);
    }
    if (session.ip !== ip || session.consumed) {
      throw new BadRequestException(SESSION_MESSAGE);
    }
    if (++session.requests > 30) {
      throw new HttpException(RATE_LIMIT_MESSAGE, 429);
    }
    const result = await this.places.autocomplete(input);
    const suggestions = result.suggestions.slice(0, 5);
    // Retain only IDs (at most 30 searches x 5 IDs), never address text.
    // A late autocomplete response must not reopen a completed session.
    if (!session.consumed && session.until > Date.now()) {
      for (const suggestion of suggestions) {
        session.placeIds.add(suggestion.placeId);
      }
    }
    return { suggestions };
  }

  async details(ip: string, input: PlaceDetailsDto) {
    const now = Date.now();
    this.admitRequest(ip, now);
    const session = this.sessions.get(input.sessionToken);
    if (
      !session ||
      session.until <= now ||
      session.ip !== ip ||
      session.consumed ||
      !session.placeIds.has(input.placeId)
    ) {
      throw new BadRequestException(SESSION_MESSAGE);
    }
    // Reserve before awaiting Google so concurrent/replayed requests cannot bill twice.
    session.consumed = true;
    session.placeIds.clear();
    return this.places.details(input);
  }
}
